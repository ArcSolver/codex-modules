import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatStamp } from "./time.js";
import { type StoreOptions } from "./types.js";

export function resolveStoreDir(opts: StoreOptions = {}): string {
  const env = opts.env ?? process.env;
  return resolve(opts.storeDir ?? env.CODEX_SCHEDULER_HOME ?? join(homedir(), ".codex-modules", "scheduler"));
}

export function ensureStoreDirs(storeDir: string): void {
  for (const dir of [storeDir, join(storeDir, "locks"), join(storeDir, "outputs"), join(storeDir, "scripts"), join(storeDir, "logs"), join(storeDir, "install"), join(storeDir, "backups")]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function resolveScriptRoot(storeDir: string): string {
  const root = join(storeDir, "scripts");
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export function safeJobId(date = new Date()): string {
  return `j_${formatStamp(date)}_${randomId(8)}`;
}

export function safeRunId(date = new Date()): string {
  return `r_${formatStamp(date)}_${randomId(4)}`;
}

export function outputPaths(storeDir: string, jobId: string, runId: string) {
  assertSafeId(jobId, "job id");
  assertSafeId(runId, "run id");
  const runDir = join(storeDir, "outputs", jobId, runId);
  return {
    runDir,
    output: join(runDir, "output.md"),
    events: join(runDir, "events.jsonl"),
    stderr: join(runDir, "stderr.log"),
    scriptStdout: join(runDir, "script.stdout.log"),
    scriptStderr: join(runDir, "script.stderr.log"),
    meta: join(runDir, "meta.json"),
  };
}

export function isSubpath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveInside(child: string, parent: string): string {
  const candidate = resolve(parent, child);
  if (!isSubpath(candidate, parent)) throw new Error(`Path escapes root: ${child}`);
  return candidate;
}

export function relativeToStore(storeDir: string, path: string): string {
  return relative(storeDir, path).split(sep).join("/");
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function resolveExistingDir(path: string): string {
  const real = realpathSync(path);
  if (!existsSync(real)) throw new Error(`Directory does not exist: ${path}`);
  return real;
}

function assertSafeId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${label}: ${id}`);
}

function randomId(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, "0");
}
