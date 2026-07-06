import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "./lock.js";
import { ensureStoreDirs, resolveStoreDir } from "./paths.js";
import { type JobStoreFile, type StoreOptions } from "./types.js";

export function loadStore(storeDir: string): JobStoreFile {
  ensureStoreDirs(storeDir);
  const path = jobsPath(storeDir);
  if (!existsSync(path)) return { version: 1, jobs: [] };
  const text = readFileSync(path, "utf8").trim();
  if (!text) return { version: 1, jobs: [] };
  const parsed = JSON.parse(text) as JobStoreFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error(`Unsupported scheduler store format: ${path}`);
  return parsed;
}

export function saveStoreAtomic(storeDir: string, store: JobStoreFile): void {
  ensureStoreDirs(storeDir);
  const target = jobsPath(storeDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

export function withStoreMutation<T>(opts: StoreOptions, fn: (store: JobStoreFile, storeDir: string) => T): T {
  const storeDir = resolveStoreDir(opts);
  ensureStoreDirs(storeDir);
  return withLock(join(storeDir, "locks", "jobs.lock"), { ttlMs: 30_000, waitMs: 10_000, purpose: "jobs" }, () => {
    const store = loadStore(storeDir);
    const result = fn(store, storeDir);
    saveStoreAtomic(storeDir, store);
    return result;
  });
}

export function readStore(opts: StoreOptions = {}): { store: JobStoreFile; storeDir: string } {
  const storeDir = resolveStoreDir(opts);
  return { store: loadStore(storeDir), storeDir };
}

export function removeStoreOutputs(storeDir: string, jobId: string): void {
  rmSync(join(storeDir, "outputs", jobId), { recursive: true, force: true });
}

function jobsPath(storeDir: string): string {
  return join(storeDir, "jobs.json");
}
