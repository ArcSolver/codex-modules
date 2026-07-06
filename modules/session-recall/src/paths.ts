import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { RecallPaths } from "./types.js";

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(expandHome(env.CODEX_HOME ?? path.join(os.homedir(), ".codex")));
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    expandHome(env.CODEX_SESSION_RECALL_STATE_DIR ?? path.join(os.homedir(), ".codex-modules", "session-recall")),
  );
}

export function resolveRecallPaths(options: { codexHome?: string; stateDir?: string }): RecallPaths {
  const codexHome = path.resolve(expandHome(options.codexHome ?? defaultCodexHome()));
  const stateDir = path.resolve(expandHome(options.stateDir ?? defaultStateDir()));
  return {
    codexHome,
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
  };
}

export function ensureStateDir(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
}
