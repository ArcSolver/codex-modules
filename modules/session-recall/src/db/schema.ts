import type { SqlDatabase } from "./adapter.js";
import { probeFts5, probeTrigram } from "./better-sqlite3.js";

export function applyPragmas(db: SqlDatabase): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    db.exec("PRAGMA journal_mode = DELETE");
  }
}

export function initializeDatabase(db: SqlDatabase): { fts5: true; trigram: boolean } {
  applyPragmas(db);
  const fts = probeFts5(db);
  if (!fts.ok) {
    throw new Error(`SQLite FTS5 is required but unavailable in better-sqlite3: ${fts.error}`);
  }
  createCoreSchema(db);
  createFtsSchema(db);
  const trigram = createTrigramSchemaIfAvailable(db);
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run("schema_version", "1");
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run("trigram_enabled", trigram ? "1" : "0");
  return { fts5: true, trigram };
}

export function createCoreSchema(db: SqlDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  path_hash TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  source_bucket TEXT NOT NULL,
  session_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'indexed',
  error TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  codex_home TEXT,
  state_dir TEXT NOT NULL,
  options_json TEXT NOT NULL,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_indexed INTEGER NOT NULL DEFAULT 0,
  files_unchanged INTEGER NOT NULL DEFAULT 0,
  messages_indexed INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
  thread_id TEXT,
  parent_thread_id TEXT,
  forked_from_id TEXT,
  lineage_root_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'interactive',
  subagent_depth INTEGER,
  originator TEXT,
  cli_version TEXT,
  cwd TEXT,
  model TEXT,
  title TEXT,
  started_at TEXT,
  updated_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  line_type TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT,
  search_text TEXT NOT NULL,
  tool_name TEXT,
  call_id TEXT,
  turn_id TEXT,
  timestamp TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  raw_kind TEXT,
  UNIQUE(session_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_line
  ON messages(session_id, line_no, payload_type, role, IFNULL(call_id, ''));

CREATE INDEX IF NOT EXISTS idx_files_stat
  ON indexed_files(path, mtime_ms, size_bytes);

CREATE INDEX IF NOT EXISTS idx_sessions_lineage
  ON sessions(lineage_root_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_updated
  ON sessions(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd
  ON sessions(cwd, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_session_seq
  ON messages(session_id, seq);

CREATE INDEX IF NOT EXISTS idx_messages_role
  ON messages(role);

CREATE INDEX IF NOT EXISTS idx_messages_tool_name
  ON messages(tool_name);
`);
}

export function createFtsSchema(db: SqlDatabase): void {
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(search_text);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert
AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, search_text)
  VALUES (new.id, COALESCE(new.search_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
  INSERT INTO messages_fts(rowid, search_text)
  VALUES (new.id, COALESCE(new.search_text, ''));
END;
`);
}

export function createTrigramSchemaIfAvailable(db: SqlDatabase): boolean {
  const trigram = probeTrigram(db);
  if (!trigram.ok) {
    return false;
  }
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(search_text, tokenize='trigram');

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_insert
AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts_trigram(rowid, search_text)
  VALUES (new.id, COALESCE(new.search_text, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_delete
AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts_trigram WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_update
AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts_trigram WHERE rowid = old.id;
  INSERT INTO messages_fts_trigram(rowid, search_text)
  VALUES (new.id, COALESCE(new.search_text, ''));
END;
`);
  return true;
}

export function rebuildFts(db: SqlDatabase): void {
  db.exec("DELETE FROM messages_fts");
  db.exec("INSERT INTO messages_fts(rowid, search_text) SELECT id, COALESCE(search_text, '') FROM messages");
  const trigram = db.prepare<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'trigram_enabled'").get()?.value === "1";
  if (trigram) {
    db.exec("DELETE FROM messages_fts_trigram");
    db.exec("INSERT INTO messages_fts_trigram(rowid, search_text) SELECT id, COALESCE(search_text, '') FROM messages");
  }
}
