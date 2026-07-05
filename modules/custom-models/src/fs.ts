// Adapted from opencodex src/config.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let atomicSeq = 0;

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.ccm.${process.pid}.${++atomicSeq}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, path);
}

export function expandUserPath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

