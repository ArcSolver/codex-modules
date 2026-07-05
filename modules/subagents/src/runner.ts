import { spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { findCodexBinary } from "./kit/index.js";
import type { BuildArgvOptions, ResolvedRunTasksOptions, RunTasksOptions, TaskResult, TaskSpec } from "./types.js";

const DEFAULT_PARALLEL = 2;
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_STALL_SEC = 180;

export function buildArgv(task: TaskSpec, opts: BuildArgvOptions): string[] {
  assertTask(task);
  const lastMessagePath = join(opts.outDir, `${task.id}.md`);
  const argv = ["exec", "--skip-git-repo-check"];

  if (task.cwd) argv.push("-C", task.cwd);
  argv.push("-s", task.sandbox ?? "read-only");
  if (task.model) argv.push("-m", task.model);
  if (task.effort) argv.push("-c", `model_reasoning_effort=${task.effort}`);

  const overrides = task.configOverrides ?? {};
  for (const key of Object.keys(overrides).sort()) {
    if (isDangerousConfigKey(key) || isDangerousConfigValue(overrides[key])) {
      throw new Error(`dangerous Codex config override is not allowed: ${key}`);
    }
    argv.push("-c", `${key}=${overrides[key]}`);
  }

  if (task.outputSchemaPath) argv.push("--output-schema", task.outputSchemaPath);
  argv.push("-o", lastMessagePath, "--json");
  if (opts.ephemeral) argv.push("--ephemeral");
  argv.push(task.prompt);
  return argv;
}

export async function runTasks(tasks: TaskSpec[], opts: RunTasksOptions): Promise<TaskResult[]> {
  const resolved = resolveOptions(opts);
  mkdirSync(resolved.outDir, { recursive: true });
  const results = new Array<TaskResult>(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await runOne(tasks[index]!, resolved);
    }
  }

  const workers = Array.from({ length: Math.min(resolved.parallel, Math.max(tasks.length, 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

function resolveOptions(opts: RunTasksOptions): ResolvedRunTasksOptions {
  const bin = opts.bin ?? findCodexBinary();
  if (!bin) throw new Error("codex binary not found; pass opts.bin or put codex on PATH");
  const parallel = opts.parallel ?? DEFAULT_PARALLEL;
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const stallSec = opts.stallSec ?? DEFAULT_STALL_SEC;
  if (!Number.isInteger(parallel) || parallel < 1) throw new Error("parallel must be an integer >= 1");
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("timeoutSec must be > 0");
  if (!Number.isFinite(stallSec) || stallSec <= 0) throw new Error("stallSec must be > 0");
  return {
    parallel,
    timeoutSec,
    stallSec,
    outDir: opts.outDir,
    codexHome: opts.codexHome,
    bin,
    ephemeral: opts.ephemeral ?? true,
    resume: opts.resume ?? false,
  };
}

async function runOne(task: TaskSpec, opts: ResolvedRunTasksOptions): Promise<TaskResult> {
  assertTask(task);
  const startedAt = Date.now();
  const lastMessagePath = join(opts.outDir, `${task.id}.md`);
  const eventsPath = join(opts.outDir, `${task.id}.events.jsonl`);
  const stderrPath = join(opts.outDir, `${task.id}.stderr.log`);

  if (opts.resume && existsSync(lastMessagePath)) {
    return {
      id: task.id,
      status: "ok",
      exitCode: 0,
      durationMs: 0,
      lastMessagePath,
      eventsPath,
    };
  }

  const argv = buildArgv(task, opts);
  const events = createWriteStream(eventsPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  let exitCode: number | null = null;
  let status: TaskResult["status"] | null = null;

  await new Promise<void>(resolve => {
    const devNullFd = openSync("/dev/null", "r");
    const child = spawn(opts.bin, argv, {
      env: opts.codexHome ? { ...process.env, CODEX_HOME: opts.codexHome } : process.env,
      stdio: [devNullFd, "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      status = "error";
      child.kill("SIGTERM");
      try {
        closeSync(devNullFd);
      } catch {
        // Best effort only.
      }
      events.end(() => {
        stderr.end(() => resolve());
      });
      return;
    }
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);

    const timeoutTimer = setTimeout(() => {
      status = "timeout";
      child.kill("SIGTERM");
    }, opts.timeoutSec * 1000);

    const stallTimer = setInterval(() => {
      if (Date.now() - latestMtimeMs([lastMessagePath, eventsPath, stderrPath], startedAt) > opts.stallSec * 1000) {
        status = "stall";
        child.kill("SIGTERM");
      }
    }, Math.max(250, Math.min(1000, opts.stallSec * 1000)));

    child.once("error", () => {
      status = "error";
    });

    child.once("close", code => {
      exitCode = code;
      clearTimeout(timeoutTimer);
      clearInterval(stallTimer);
      try {
        closeSync(devNullFd);
      } catch {
        // Best effort only.
      }
      events.end(() => {
        stderr.end(() => resolve());
      });
    });
  });

  if (!status) status = exitCode === 0 && existsSync(lastMessagePath) ? "ok" : "error";
  return {
    id: task.id,
    status,
    exitCode,
    durationMs: Date.now() - startedAt,
    lastMessagePath,
    eventsPath,
  };
}

function latestMtimeMs(paths: string[], fallback: number): number {
  let latest = fallback;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      // File may not exist yet.
    }
  }
  return latest;
}

function assertTask(task: TaskSpec): void {
  if (!task || typeof task !== "object") throw new Error("task must be an object");
  if (!isSafeTaskId(task.id)) throw new Error(`invalid task id: ${String(task.id)}`);
  if (typeof task.prompt !== "string" || task.prompt.length === 0) throw new Error(`task ${task.id} prompt is required`);
  if (task.sandbox && task.sandbox !== "read-only" && task.sandbox !== "workspace-write") {
    throw new Error(`task ${task.id} sandbox must be read-only or workspace-write`);
  }
}

function isSafeTaskId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith(".") && id.length <= 120;
}

function isDangerousConfigKey(key: string): boolean {
  return /danger|bypass/i.test(key);
}

function isDangerousConfigValue(value: string | undefined): boolean {
  return typeof value === "string" && /dangerously-bypass-approvals-and-sandbox|danger-full-access/i.test(value);
}
