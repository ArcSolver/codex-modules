import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import type { SqlDatabase } from "./adapter.js";

const require = createRequire(import.meta.url);
const DatabaseConstructor = require("better-sqlite3") as typeof BetterSqlite3;

export function openDatabase(dbPath: string): SqlDatabase {
  return new DatabaseConstructor(dbPath) as unknown as SqlDatabase;
}

export function openReadonlyDatabase(dbPath: string): SqlDatabase {
  return new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true }) as unknown as SqlDatabase;
}

export function probeFts5(db: SqlDatabase): { ok: true } | { ok: false; error: string } {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __session_recall_fts_probe USING fts5(content)");
    db.exec("DROP TABLE IF EXISTS __session_recall_fts_probe");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function probeTrigram(db: SqlDatabase): { ok: true } | { ok: false; error: string } {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __session_recall_trigram_probe USING fts5(content, tokenize='trigram')");
    db.exec("DROP TABLE IF EXISTS __session_recall_trigram_probe");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
