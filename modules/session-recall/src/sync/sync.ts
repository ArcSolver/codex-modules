import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DiscoveredFile, ParsedRollout, SyncOptions, SyncResult } from "../types.js";
import { ensureStateDir, resolveRecallPaths } from "../paths.js";
import { openDatabase } from "../db/better-sqlite3.js";
import type { SqlDatabase } from "../db/adapter.js";
import { initializeDatabase, rebuildFts } from "../db/schema.js";
import { parseRolloutFile } from "../parse/rollout.js";
import { discoverRolloutFiles } from "./discover.js";

interface ExistingFileRow {
  id: number;
  path: string;
  mtime_ms: number;
  size_bytes: number;
  session_id?: string;
}

interface MetadataHints {
  titles: Map<string, { title?: string; updatedAt?: string }>;
  history: Map<string, string>;
}

export async function sync(options: SyncOptions = {}): Promise<SyncResult> {
  const paths = resolveRecallPaths(options);
  ensureStateDir(paths.stateDir);
  const db = openDatabase(paths.dbPath);
  const warnings: string[] = [];

  try {
    initializeDatabase(db);
    const files = await discoverRolloutFiles(options);
    const hints = await readMetadataHints(paths.codexHome, warnings);
    const result: SyncResult = {
      success: true,
      mode: "sync",
      stateDir: paths.stateDir,
      dbPath: options.debugPaths ? paths.dbPath : undefined,
      files: { indexed: 0, updated: 0, unchanged: 0, deleted: 0 },
      sessions: { inserted: 0, updated: 0 },
      messages: { inserted: 0, updated: 0 },
      dryRun: options.dryRun || undefined,
      warnings,
    };

    if (options.rebuild && !options.dryRun) {
      db.transaction(() => {
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM sessions");
        db.exec("DELETE FROM indexed_files");
      })();
    }

    for (const file of files) {
      const existing = db
        .prepare<ExistingFileRow>("SELECT id, path, mtime_ms, size_bytes, session_id FROM indexed_files WHERE path = ?")
        .get(file.path);
      const isChanged = !existing || existing.mtime_ms !== file.mtimeMs || existing.size_bytes !== file.sizeBytes || options.rebuild;
      if (!isChanged) {
        result.files.unchanged += 1;
        continue;
      }
      if (options.dryRun) {
        if (existing) {
          result.files.updated += 1;
        } else {
          result.files.indexed += 1;
        }
        continue;
      }

      try {
        const parsed = await parseRolloutFile(file.path, options);
        result.warnings.push(...parsed.warnings);
        if (options.sessionId && parsed.session.sessionId !== options.sessionId && parsed.session.threadId !== options.sessionId) {
          continue;
        }
        if (options.cwdPrefix && (!parsed.session.cwd || !parsed.session.cwd.startsWith(options.cwdPrefix))) {
          continue;
        }
        if (options.excludeSubagents && parsed.session.sourceType === "subagent") {
          continue;
        }
        applyMetadataHints(parsed, hints);
        const counts = replaceFileRows(db, file, parsed, existing);
        if (existing) {
          result.files.updated += 1;
          result.sessions.updated += counts.sessions;
          result.messages.updated += counts.messages;
        } else {
          result.files.indexed += 1;
          result.sessions.inserted += counts.sessions;
          result.messages.inserted += counts.messages;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`${file.path}: ${message}`);
        recordFileError(db, file, message);
      }
    }

    recomputeLineageRoots(db);
    rebuildFts(db);
    recordSyncRun(db, paths.codexHome, paths.stateDir, options, result, true);
    return result;
  } catch (error) {
    const result: SyncResult = {
      success: false,
      mode: "sync",
      stateDir: paths.stateDir,
      dbPath: options.debugPaths ? paths.dbPath : undefined,
      files: { indexed: 0, updated: 0, unchanged: 0, deleted: 0 },
      sessions: { inserted: 0, updated: 0 },
      messages: { inserted: 0, updated: 0 },
      warnings: [error instanceof Error ? error.message : String(error)],
    };
    try {
      recordSyncRun(db, paths.codexHome, paths.stateDir, options, result, false);
    } catch {
      // Best-effort failure record only.
    }
    return result;
  } finally {
    db.close();
  }
}

export async function syncFile(db: SqlDatabase, file: DiscoveredFile, options: SyncOptions = {}): Promise<{ sessions: number; messages: number }> {
  const parsed = await parseRolloutFile(file.path, options);
  return replaceFileRows(db, file, parsed);
}

export function shouldIndexFile(db: SqlDatabase, file: DiscoveredFile): boolean {
  const existing = db
    .prepare<ExistingFileRow>("SELECT id, path, mtime_ms, size_bytes FROM indexed_files WHERE path = ?")
    .get(file.path);
  return !existing || existing.mtime_ms !== file.mtimeMs || existing.size_bytes !== file.sizeBytes;
}

export function replaceFileRows(
  db: SqlDatabase,
  file: DiscoveredFile,
  parsed: ParsedRollout,
  existing?: ExistingFileRow,
): { sessions: number; messages: number } {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const fileId = upsertIndexedFile(db, file, parsed, now);
    db.prepare("DELETE FROM sessions WHERE file_id = ?").run(fileId);
    db.prepare(
      `INSERT INTO sessions (
        session_id, file_id, thread_id, parent_thread_id, forked_from_id, lineage_root_id,
        source_type, subagent_depth, originator, cli_version, cwd, model, title,
        started_at, updated_at, message_count, tool_call_count, meta_json, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      parsed.session.sessionId,
      fileId,
      parsed.session.threadId,
      parsed.session.parentThreadId,
      parsed.session.forkedFromId,
      parsed.session.lineageRootId,
      parsed.session.sourceType,
      parsed.session.subagentDepth,
      parsed.session.originator,
      parsed.session.cliVersion,
      parsed.session.cwd,
      parsed.session.model,
      parsed.session.title,
      parsed.session.startedAt,
      parsed.session.updatedAt,
      parsed.messages.length,
      parsed.messages.filter((message) => message.role === "function").length,
      parsed.session.metaJson,
      now,
    );

    const insertMessage = db.prepare(
      `INSERT INTO messages (
        session_id, seq, line_no, line_type, payload_type, role, text, search_text,
        tool_name, call_id, turn_id, timestamp, truncated, raw_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of parsed.messages) {
      insertMessage.run(
        parsed.session.sessionId,
        message.seq,
        message.lineNo,
        message.lineType,
        message.payloadType,
        message.role,
        message.text,
        message.searchText,
        message.toolName,
        message.callId,
        message.turnId,
        message.timestamp,
        message.truncated ? 1 : 0,
        message.rawKind,
      );
    }
    void existing;
    return { sessions: 1, messages: parsed.messages.length };
  })();
}

export function upsertIndexedFile(db: SqlDatabase, file: DiscoveredFile, parsed: ParsedRollout, now: string): number {
  const existing = db.prepare<{ id: number }>("SELECT id FROM indexed_files WHERE path = ?").get(file.path);
  const pathHash = crypto.createHash("sha256").update(file.path).digest("hex");
  if (existing) {
    db.prepare(
      `UPDATE indexed_files
       SET path_hash = ?, mtime_ms = ?, size_bytes = ?, source_bucket = ?,
           session_id = ?, last_indexed_at = ?, status = 'indexed', error = NULL
       WHERE id = ?`,
    ).run(pathHash, file.mtimeMs, file.sizeBytes, file.sourceBucket, parsed.session.sessionId, now, existing.id);
    return existing.id;
  }
  const inserted = db
    .prepare(
      `INSERT INTO indexed_files (
        path, path_hash, mtime_ms, size_bytes, source_bucket, session_id,
        first_seen_at, last_indexed_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed')`,
    )
    .run(file.path, pathHash, file.mtimeMs, file.sizeBytes, file.sourceBucket, parsed.session.sessionId, now, now);
  return Number(inserted.lastInsertRowid);
}

export function recomputeLineageRoots(db: SqlDatabase): void {
  const rows = db
    .prepare<{ session_id: string; thread_id?: string; parent_thread_id?: string }>(
      "SELECT session_id, thread_id, parent_thread_id FROM sessions",
    )
    .all();
  const bySession = new Map(rows.map((row) => [row.session_id, row]));
  const byThread = new Map(rows.filter((row) => row.thread_id).map((row) => [row.thread_id as string, row]));
  const update = db.prepare("UPDATE sessions SET lineage_root_id = ? WHERE session_id = ?");

  for (const row of rows) {
    const seen = new Set<string>([row.session_id]);
    let current = row;
    let root = row.session_id;
    while (current.parent_thread_id) {
      const parent = bySession.get(current.parent_thread_id) ?? byThread.get(current.parent_thread_id);
      if (!parent || seen.has(parent.session_id)) {
        break;
      }
      root = parent.session_id;
      seen.add(parent.session_id);
      current = parent;
    }
    update.run(root, row.session_id);
  }
}

function recordFileError(db: SqlDatabase, file: DiscoveredFile, error: string): void {
  const now = new Date().toISOString();
  const pathHash = crypto.createHash("sha256").update(file.path).digest("hex");
  db.prepare(
    `INSERT INTO indexed_files (
      path, path_hash, mtime_ms, size_bytes, source_bucket, first_seen_at, last_indexed_at, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'error', ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      source_bucket = excluded.source_bucket,
      last_indexed_at = excluded.last_indexed_at,
      status = 'error',
      error = excluded.error`,
  ).run(file.path, pathHash, file.mtimeMs, file.sizeBytes, file.sourceBucket, now, now, error);
}

function recordSyncRun(
  db: SqlDatabase,
  codexHome: string,
  stateDir: string,
  options: SyncOptions,
  result: SyncResult,
  success: boolean,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sync_runs (
      started_at, finished_at, codex_home, state_dir, options_json, files_seen,
      files_indexed, files_unchanged, messages_indexed, success, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now,
    now,
    codexHome,
    stateDir,
    JSON.stringify({ ...options, path: options.debugPaths ? options.path : options.path ? "[redacted]" : undefined }),
    result.files.indexed + result.files.updated + result.files.unchanged,
    result.files.indexed + result.files.updated,
    result.files.unchanged,
    result.messages.inserted + result.messages.updated,
    success ? 1 : 0,
    success ? null : result.warnings.join("\n"),
  );
}

async function readMetadataHints(codexHome: string, warnings: string[]): Promise<MetadataHints> {
  const titles = new Map<string, { title?: string; updatedAt?: string }>();
  const history = new Map<string, string>();
  await readJsonlFile(path.join(codexHome, "session_index.jsonl"), (value) => {
    if (!isRecord(value)) {
      return;
    }
    const id = stringValue(value.id) ?? stringValue(value.session_id);
    if (!id) {
      return;
    }
    titles.set(id, {
      title: stringValue(value.thread_name) ?? stringValue(value.title),
      updatedAt: stringValue(value.updated_at),
    });
  }, warnings);
  await readJsonlFile(path.join(codexHome, "history.jsonl"), (value) => {
    if (!isRecord(value)) {
      return;
    }
    const id = stringValue(value.session_id);
    const text = stringValue(value.text);
    if (id && text && !history.has(id)) {
      history.set(id, text);
    }
  }, warnings);
  return { titles, history };
}

function applyMetadataHints(parsed: ParsedRollout, hints: MetadataHints): void {
  const titleHint = hints.titles.get(parsed.session.sessionId) ?? (parsed.session.threadId ? hints.titles.get(parsed.session.threadId) : undefined);
  parsed.session.title = parsed.session.title ?? titleHint?.title ?? hints.history.get(parsed.session.sessionId);
  parsed.session.updatedAt = parsed.session.updatedAt ?? titleHint?.updatedAt;
}

async function readJsonlFile(filePath: string, onValue: (value: unknown) => void, warnings: string[]): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      onValue(JSON.parse(line) as unknown);
    } catch (error) {
      warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
