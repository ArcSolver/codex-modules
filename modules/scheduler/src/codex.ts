import { closeSync, existsSync, openSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { outputPaths } from "./paths.js";
import { assertNoForbiddenArgv, assertSafeCodexConfig, sanitizeEnv } from "./safety.js";
import { type JobRecord, type OutputStatus, type RunOptions } from "./types.js";

export type CodexRunResult = {
  status: OutputStatus;
  error?: string;
};

export function buildCodexArgv(job: JobRecord, storeDir: string, runId: string): string[] {
  assertSafeCodexConfig(job.codex);
  if (!job.codex.prompt) throw new Error("Codex job is missing prompt");
  const paths = outputPaths(storeDir, job.id, runId);
  const args = ["exec", "--skip-git-repo-check"];
  if (job.cwd) args.push("-C", job.cwd);
  args.push("-s", job.codex.sandbox);
  if (job.codex.model) args.push("-m", job.codex.model);
  if (job.codex.effort) args.push("-c", `model_reasoning_effort=${job.codex.effort}`);
  args.push("-o", paths.output, "--json", "--ephemeral", job.codex.prompt);
  assertNoForbiddenArgv(args);
  return args;
}

export async function runCodexExec(job: JobRecord, storeDir: string, runId: string, opts: RunOptions = {}): Promise<CodexRunResult> {
  const paths = outputPaths(storeDir, job.id, runId);
  const args = buildCodexArgv(job, storeDir, runId);
  const bin = opts.bin ?? opts.env?.CODEX_BIN ?? process.env.CODEX_BIN ?? "codex";
  const devNull = openSync(process.platform === "win32" ? "NUL" : "/dev/null", "r");
  const eventsFd = openSync(paths.events, "a");
  const stderrFd = openSync(paths.stderr, "a");
  if (!existsSync(paths.output)) writeFileSync(paths.output, "");
  let status: OutputStatus | null = null;
  const child = spawn(bin, args, {
    cwd: job.cwd ?? storeDir,
    env: sanitizeEnv(process.env, { codexHome: opts.codexHome }),
    stdio: [devNull, eventsFd, stderrFd],
  });
  const timeoutMs = (opts.timeoutSec ?? 600) * 1000;
  const stallMs = (opts.stallSec ?? 180) * 1000;
  const watched = [paths.events, paths.output, paths.stderr];
  const started = Date.now();
  let lastProgress = latestMtime(watched, started);
  const monitor = setInterval(() => {
    const current = latestMtime(watched, started);
    if (current > lastProgress) lastProgress = current;
    const age = Date.now() - lastProgress;
    if (age > stallMs) {
      status = "stall";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    }
  }, Math.min(1000, Math.max(100, stallMs / 4)));
  const timeout = setTimeout(() => {
    status = "timeout";
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000).unref();
  }, timeoutMs);
  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    clearInterval(monitor);
    clearTimeout(timeout);
    if (status) return { status, error: `codex ${status}` };
    if (code === 0) return { status: "ok" };
    return { status: "error", error: `codex exited with ${code ?? signal}` };
  } finally {
    closeSync(devNull);
    closeSync(eventsFd);
    closeSync(stderrFd);
  }
}

export function latestMtime(paths: string[], fallback: number): number {
  let latest = fallback;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      // Missing files count as no progress.
    }
  }
  return latest;
}
