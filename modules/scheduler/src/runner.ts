import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeNextRun, parseSchedule } from "./schedule.js";
import { assertSafeCodexConfig, assertSafeCwd, assertSafeJob, assertSafeSandbox, scanCredentialExfil } from "./safety.js";
import { claimDueJobs, claimManualRun, completeClaim, findDueJobs } from "./claims.js";
import { outputPaths, relativeToStore, resolveScriptRoot, safeJobId } from "./paths.js";
import { readStore, removeStoreOutputs, withStoreMutation } from "./store.js";
import { runCodexExec } from "./codex.js";
import { runJobScript, writeNoAgentOutput } from "./script.js";
import { toDate, toLocalIso } from "./time.js";
import {
  type Claim,
  type CreateJobInput,
  type JobRecord,
  type OutputRef,
  type OutputStatus,
  type RemoveOptions,
  type RunOptions,
  type StoreOptions,
  type TickOptions,
} from "./types.js";

export function createJob(input: CreateJobInput, options: StoreOptions = {}): JobRecord {
  return withStoreMutation(options, (store, storeDir) => {
    const now = toDate();
    const schedule = parseSchedule(input.scheduleInput, { now });
    const codexEnabled = input.codex?.enabled ?? !input.noAgent;
    const sandbox = input.codex?.sandbox ?? "read-only";
    assertSafeSandbox(sandbox);
    const cwd = input.cwd ? assertSafeCwd(input.cwd) : null;
    const script = input.scriptPath ? {
      path: normalizeScriptPath(input.scriptPath, storeDir),
      noAgent: !!input.noAgent,
      timeoutSec: 60,
      wakeGate: true,
    } : null;
    const prompt = input.prompt ?? input.codex?.prompt ?? null;
    if (!script && !codexEnabled) throw new Error("Job must have a script or Codex prompt");
    if (codexEnabled && !prompt) throw new Error("Codex job requires a prompt");
    scanCredentialExfil(prompt, "prompt");
    assertSafeCodexConfig({ enabled: codexEnabled, prompt, model: input.codex?.model ?? null, effort: input.codex?.effort ?? null, sandbox });
    const job: JobRecord = {
      id: safeJobId(now),
      name: input.name ?? "Scheduled Codex job",
      enabled: true,
      state: "scheduled",
      createdAt: toLocalIso(now),
      updatedAt: toLocalIso(now),
      scheduleInput: input.scheduleInput,
      scheduleDisplay: input.scheduleInput,
      schedule,
      nextRunAt: computeNextRun(schedule, { now }),
      repeat: { times: input.repeat === undefined ? (schedule.kind === "once" ? 1 : null) : input.repeat, completed: 0 },
      cwd,
      script,
      codex: {
        enabled: codexEnabled,
        prompt,
        model: input.codex?.model ?? null,
        effort: input.codex?.effort ?? null,
        sandbox,
        ephemeral: true,
        skipGitRepoCheck: true,
      },
      claim: null,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastOutput: null,
      outputs: [],
    };
    assertSafeJob(job, { storeDir });
    store.jobs.push(job);
    return structuredClone(job);
  });
}

export function listJobs(options: StoreOptions & { all?: boolean } = {}): JobRecord[] {
  const { store } = readStore(options);
  return structuredClone(options.all ? store.jobs : store.jobs.filter(job => job.enabled && (job.state === "scheduled" || job.state === "running")));
}

export function removeJob(id: string, options: RemoveOptions = {}): { removed: boolean; id: string } {
  return withStoreMutation(options, (store, storeDir) => {
    const before = store.jobs.length;
    store.jobs = store.jobs.filter(job => job.id !== id);
    if (options.deleteOutputs) removeStoreOutputs(storeDir, id);
    return { removed: store.jobs.length !== before, id };
  });
}

export async function runJob(id: string, options: RunOptions = {}): Promise<{ jobId: string; runId?: string; status: OutputStatus; dryRun: boolean; output?: OutputRef; error?: string | null }> {
  const now = toDate(options.now);
  if (!options.execute) {
    const { store } = readStore(options);
    const job = store.jobs.find(item => item.id === id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return { jobId: id, status: "dry-run", dryRun: true };
  }
  const { job, claim, storeDir } = withStoreMutation(options, (store, lockedStoreDir) => {
    const found = store.jobs.find(item => item.id === id);
    if (!found) throw new Error(`Unknown job: ${id}`);
    if (found.codex.enabled && !options.allowCodex) throw new Error("Codex execution requires --allow-codex");
    const claim = claimManualRun(found, now);
    return { job: structuredClone(found), claim, storeDir: lockedStoreDir };
  });
  const result = await executeClaimedJob(job, claim, storeDir, { ...options, manual: true });
  withStoreMutation(options, store => {
    completeClaim(store, job.id, claim.runId, { ...result, manual: true });
  });
  return { jobId: job.id, runId: claim.runId, status: result.status, dryRun: false, output: result.output, error: result.error };
}

export async function tick(options: TickOptions = {}): Promise<{ dryRun: boolean; due: unknown[]; results: unknown[] }> {
  const now = toDate(options.now);
  if (!options.execute) {
    const { store } = readStore(options);
    const due = findDueJobs(store, now).slice(0, options.limit ?? Number.POSITIVE_INFINITY).map(job => ({
      id: job.id,
      name: job.name,
      nextRunAt: job.nextRunAt,
      requiresAllowCodex: job.codex.enabled,
      wouldRun: !job.codex.enabled || !!options.allowCodex,
    }));
    return { dryRun: true, due, results: [] };
  }
  const claimed = withStoreMutation(options, store => claimDueJobs(store, { now, limit: options.limit, allowCodex: options.allowCodex }));
  const { storeDir } = readStore(options);
  const results = [];
  for (const item of claimed) {
    const result = await executeClaimedJob(item.job, item.claim, storeDir, { ...options, manual: false });
    withStoreMutation(options, store => {
      completeClaim(store, item.job.id, item.claim.runId, { ...result, manual: false });
    });
    results.push({ jobId: item.job.id, runId: item.claim.runId, status: result.status, error: result.error ?? null });
  }
  return { dryRun: false, due: claimed.map(item => item.job.id), results };
}

export async function executeClaimedJob(job: JobRecord, claim: Claim, storeDir: string, options: RunOptions = {}): Promise<{ status: OutputStatus; error?: string | null; output: OutputRef; finishedAt: Date }> {
  const startedAt = toDate(claim.claimedAt);
  const paths = outputPaths(storeDir, job.id, claim.runId);
  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(paths.meta, JSON.stringify({ jobId: job.id, runId: claim.runId, startedAt: toLocalIso(startedAt), manual: !!options.manual }, null, 2));
  assertSafeJob(job, { storeDir });
  let status: OutputStatus = "ok";
  let error: string | null = null;
  const runtimeJob = structuredClone(job);
  if (runtimeJob.script) {
    const script = await runJobScript(runtimeJob, storeDir, claim.runId, options);
    status = script.status;
    error = script.error ?? null;
    if (runtimeJob.script.noAgent) {
      writeNoAgentOutput(storeDir, runtimeJob, claim.runId, script.stdout);
    } else if (status !== "ok") {
      // Script failure stops the job before Codex.
    } else if (!script.wakeAgent) {
      status = "skipped";
      writeFileSync(paths.output, script.stdout);
    } else if (runtimeJob.codex.prompt) {
      runtimeJob.codex.prompt = `${runtimeJob.codex.prompt}\n\nScript output:\n${script.stdout}`;
    }
  }
  if (status === "ok" && runtimeJob.codex.enabled && !(runtimeJob.script?.noAgent)) {
    if (!options.allowCodex) throw new Error("Codex execution requires --allow-codex");
    const codexResult = await runCodexExec(runtimeJob, storeDir, claim.runId, options);
    status = codexResult.status;
    error = codexResult.error ?? null;
  }
  if (!existsSync(paths.output)) writeFileSync(paths.output, status === "skipped" ? "skipped\n" : "");
  const finishedAt = new Date();
  const output: OutputRef = {
    runId: claim.runId,
    manual: !!options.manual,
    startedAt: toLocalIso(startedAt),
    finishedAt: toLocalIso(finishedAt),
    status,
    outputPath: relativeToStore(storeDir, paths.output),
    eventsPath: relativeToStore(storeDir, paths.events),
    stderrPath: relativeToStore(storeDir, paths.stderr),
    scriptStdoutPath: runtimeJob.script ? relativeToStore(storeDir, paths.scriptStdout) : undefined,
    scriptStderrPath: runtimeJob.script ? relativeToStore(storeDir, paths.scriptStderr) : undefined,
    error,
  };
  writeFileSync(paths.meta, JSON.stringify({ jobId: job.id, runId: claim.runId, startedAt: toLocalIso(startedAt), finishedAt: output.finishedAt, status, error }, null, 2));
  return { status, error, output, finishedAt };
}

function normalizeScriptPath(input: string, storeDir: string): string {
  const root = resolveScriptRoot(storeDir);
  const real = existsSync(input) ? input : join(root, input);
  const text = readFileSync(real, "utf8");
  scanCredentialExfil(text, "script content");
  const relative = real.startsWith(root) ? real.slice(root.length + 1) : input;
  if (relative.includes("..")) throw new Error("Script path traversal is not allowed");
  return relative;
}
