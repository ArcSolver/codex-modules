// Adapted from opencodex src/codex-journal.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { BACKUPS_DIRNAME, JOURNALS_DIRNAME, STATE_DIRNAME, STATE_FILENAME } from "./constants.js";
import { atomicWriteFile } from "./fs.js";
import type { CustomModelSpec, RollbackResult } from "./types.js";

export type ProviderState = {
  providerName?: string;
  profileName?: string;
  profilePath?: string;
  baseUrl: string;
  catalogPath: string;
  ownedSlugs: string[];
  models: CustomModelSpec[];
  updatedAt: string;
};

export type ModuleState = {
  version: 1;
  providers: Record<string, ProviderState>;
  lastTransactionId?: string;
};

type JournalFile = {
  path: string;
  before: string | null;
  beforeHash: string | null;
  afterHash?: string | null;
  backupPath?: string;
};

type Journal = {
  version: 1;
  id: string;
  operation: string;
  timestamp: string;
  files: JournalFile[];
};

export type ModulePaths = {
  stateDir: string;
  statePath: string;
  journalsDir: string;
  backupsDir: string;
};

export function modulePaths(codexHome: string, stateDirOverride?: string): ModulePaths {
  const stateDir = stateDirOverride ?? join(codexHome, STATE_DIRNAME);
  return {
    stateDir,
    statePath: join(stateDir, STATE_FILENAME),
    journalsDir: join(stateDir, JOURNALS_DIRNAME),
    backupsDir: join(stateDir, BACKUPS_DIRNAME),
  };
}

export function emptyState(): ModuleState {
  return { version: 1, providers: {} };
}

export function loadState(paths: ModulePaths): ModuleState {
  if (!existsSync(paths.statePath)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(paths.statePath, "utf8")) as ModuleState;
    if (parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object") return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

export function saveState(paths: ModulePaths, state: ModuleState): void {
  mkdirSync(paths.stateDir, { recursive: true });
  atomicWriteFile(paths.statePath, JSON.stringify(state, null, 2) + "\n");
}

export function removeStateIfEmpty(paths: ModulePaths, state: ModuleState): void {
  if (Object.keys(state.providers).length > 0) {
    saveState(paths, state);
    return;
  }
  try {
    unlinkSync(paths.statePath);
  } catch {
    // no state file is already the desired empty state
  }
}

function sha256(content: string | null): string | null {
  return content === null ? null : createHash("sha256").update(content).digest("hex");
}

function readContent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function transactionPath(paths: ModulePaths, id: string): string {
  return join(paths.journalsDir, `${id}.json`);
}

function safeBackupName(id: string, path: string): string {
  return `${id}-${basename(path).replace(/[^A-Za-z0-9._-]/g, "_")}.bak`;
}

export function createTransaction(paths: ModulePaths, operation: string, filePaths: string[]): string {
  mkdirSync(paths.journalsDir, { recursive: true });
  mkdirSync(paths.backupsDir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const uniquePaths = [...new Set(filePaths)];
  const files: JournalFile[] = uniquePaths.map(path => {
    const before = readContent(path);
    const backupPath = before === null ? undefined : join(paths.backupsDir, safeBackupName(id, path));
    if (backupPath && before !== null) writeFileSync(backupPath, before, { encoding: "utf8", mode: 0o600 });
    return { path, before, beforeHash: sha256(before), backupPath };
  });
  const journal: Journal = {
    version: 1,
    id,
    operation,
    timestamp: new Date().toISOString(),
    files,
  };
  atomicWriteFile(transactionPath(paths, id), JSON.stringify(journal, null, 2) + "\n");
  return id;
}

export function markTransactionAfter(paths: ModulePaths, id: string): void {
  const path = transactionPath(paths, id);
  const journal = readJournal(path);
  if (!journal) return;
  journal.files = journal.files.map(file => ({
    ...file,
    afterHash: sha256(readContent(file.path)),
  }));
  atomicWriteFile(path, JSON.stringify(journal, null, 2) + "\n");
}

function readJournal(path: string): Journal | null {
  try {
    const journal = JSON.parse(readFileSync(path, "utf8")) as Journal;
    if (journal.version !== 1 || !journal.id || !Array.isArray(journal.files)) return null;
    return journal;
  } catch {
    return null;
  }
}

function latestJournalId(paths: ModulePaths, state: ModuleState): string | undefined {
  if (state.lastTransactionId) return state.lastTransactionId;
  if (!existsSync(paths.journalsDir)) return undefined;
  const fsEntries = Array.from(new Set(readdirSync(paths.journalsDir)));
  return fsEntries
    .filter(entry => entry.endsWith(".json"))
    .map(entry => entry.slice(0, -5))
    .sort()
    .at(-1);
}

function restoreFile(path: string, content: string | null): void {
  if (content === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFile(path, content);
}

export function rollbackFromJournal(paths: ModulePaths, transactionId?: string): RollbackResult {
  const state = loadState(paths);
  const id = transactionId ?? latestJournalId(paths, state);
  if (!id) {
    return { complete: false, restored: [], skipped: [], missing: true };
  }
  const journalPath = transactionPath(paths, id);
  const journal = readJournal(journalPath);
  if (!journal) {
    return { transactionId: id, complete: false, restored: [], skipped: [], missing: true };
  }

  const restored: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const file of journal.files) {
    const currentHash = sha256(readContent(file.path));
    if (file.afterHash !== undefined && currentHash !== file.afterHash) {
      skipped.push({ path: file.path, reason: "current file hash no longer matches the transaction journal" });
      continue;
    }
    restoreFile(file.path, file.before);
    restored.push(file.path);
  }
  const complete = skipped.length === 0;
  if (complete) {
    try {
      unlinkSync(journalPath);
    } catch {
      // journal removal is best-effort
    }
  }
  return { transactionId: id, complete, restored, skipped, missing: false };
}
