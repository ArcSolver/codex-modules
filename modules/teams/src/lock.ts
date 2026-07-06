import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export type LockHandle = {
  path: string;
  release(): void;
};

export function acquireMkdirLock(path: string, opts: { ttlMs?: number; waitMs?: number; purpose?: string } = {}): LockHandle {
  const ttlMs = opts.ttlMs ?? 30_000;
  const waitMs = opts.waitMs ?? 10_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path, { recursive: false });
      writeFileSync(
        join(path, "owner.json"),
        `${JSON.stringify(
          {
            pid: process.pid,
            host: hostname(),
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
            purpose: opts.purpose ?? "teams",
          },
          null,
          2,
        )}\n`,
      );
      return {
        path,
        release() {
          rmSync(path, { recursive: true, force: true });
        },
      };
    } catch {
      if (isStale(path)) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out acquiring lock: ${path}`);
      sleep(25);
    }
  }
}

export function withLock<T>(path: string, opts: { ttlMs?: number; waitMs?: number; purpose?: string }, fn: () => T): T {
  const lock = acquireMkdirLock(path, opts);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function isStale(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { expiresAt?: string };
    return owner.expiresAt ? Date.parse(owner.expiresAt) <= Date.now() : false;
  } catch {
    return false;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
