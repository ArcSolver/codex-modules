import { resolveRecallPaths } from "../paths.js";
import { openReadonlyDatabase } from "../db/better-sqlite3.js";
import type { MessageRole, SearchOptions, SearchResultPayload, SourceType } from "../types.js";
import type { SqlDatabase } from "../db/adapter.js";
import { buildCjkFallbackTerms, containsCjk, countCjk, sanitizeFts5Query } from "./sanitize.js";
import { getAnchoredView } from "./views.js";

interface RawSearchHit {
  id: number;
  session_id: string;
  seq: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  timestamp?: string;
  lineage_root_id: string;
  parent_thread_id?: string;
  title?: string;
  cwd?: string;
  originator?: string;
  source_type: SourceType;
  started_at?: string;
  updated_at?: string;
  rollout_path?: string;
}

export async function search(options: { query: string } & SearchOptions): Promise<SearchResultPayload> {
  const paths = resolveRecallPaths(options);
  const db = openReadonlyDatabase(paths.dbPath);
  const warnings: string[] = [];
  try {
    const rawHits = searchMessages(db, options.query, options, warnings);
    const ordered = orderForRecall(rawHits);
    const deduped = dedupeByLineage(ordered, clamp(options.limit ?? 3, 1, 10));
    const results = deduped.map((hit) => {
      const view = getAnchoredView(db, hit.session_id, hit.seq, {
        window: clamp(options.window ?? 5, 0, 20),
        bookend: clamp(options.bookend ?? 3, 0, 10),
      });
      return {
        session_id: hit.session_id,
        lineage_root_id: hit.lineage_root_id,
        parent_thread_id: hit.parent_thread_id,
        title: hit.title,
        cwd: hit.cwd,
        originator: hit.originator,
        source_type: hit.source_type,
        started_at: hit.started_at,
        updated_at: hit.updated_at,
        matched_role: hit.role,
        match_message_ref: hit.seq,
        snippet: hit.snippet,
        rollout_path: options.debugPaths ? hit.rollout_path : undefined,
        ...view,
      };
    });
    return {
      success: true,
      mode: "search",
      query: options.query,
      count: results.length,
      results,
      warnings,
    };
  } finally {
    db.close();
  }
}

export function searchMessages(db: SqlDatabase, query: string, options: SearchOptions, warnings: string[] = []): RawSearchHit[] {
  const sanitized = sanitizeFts5Query(query);
  if (!sanitized) {
    return [];
  }
  const where: string[] = [];
  const params: unknown[] = [sanitized];
  applyFilters(where, params, options);
  const orderBy =
    options.sort === "newest"
      ? "m.timestamp DESC, rank"
      : options.sort === "oldest"
        ? "m.timestamp ASC, rank"
        : "rank";
  const sql = `
SELECT
  m.id, m.session_id, m.seq, m.role,
  snippet(messages_fts, 0, '>>>', '<<<', '...', 16) AS snippet,
  rank,
  m.timestamp,
  s.lineage_root_id, s.parent_thread_id, s.title, s.cwd, s.originator,
  s.source_type, s.started_at, s.updated_at,
  f.path AS rollout_path
FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
JOIN sessions s ON s.session_id = m.session_id
JOIN indexed_files f ON f.id = s.file_id
WHERE messages_fts MATCH ?
${where.length ? `AND ${where.join(" AND ")}` : ""}
ORDER BY ${orderBy}
LIMIT ?`;
  try {
    const hits = db.prepare<RawSearchHit>(sql).all(...params, clamp(options.scanLimit ?? 300, 1, 5000));
    if (hits.length === 0 && containsCjk(query) && countCjk(query) <= 2) {
      return cjkLikeFallback(db, query, options);
    }
    return hits;
  } catch (error) {
    warnings.push(`FTS query could not be parsed after sanitization: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (containsCjk(query) && countCjk(query) <= 8) {
    return cjkLikeFallback(db, query, options);
  }
  return [];
}

export function orderForRecall(hits: RawSearchHit[]): RawSearchHit[] {
  const positions = new Map(hits.map((hit, index) => [hit, index]));
  return [...hits].sort((a, b) => {
    const aSub = a.source_type === "subagent" ? 1 : 0;
    const bSub = b.source_type === "subagent" ? 1 : 0;
    if (aSub !== bSub) {
      return aSub - bSub;
    }
    return (positions.get(a) ?? 0) - (positions.get(b) ?? 0);
  });
}

export function dedupeByLineage(hits: RawSearchHit[], limit: number): RawSearchHit[] {
  const seen = new Set<string>();
  const out: RawSearchHit[] = [];
  for (const hit of hits) {
    const key = hit.lineage_root_id || hit.session_id;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function cjkLikeFallback(db: SqlDatabase, query: string, options: SearchOptions): RawSearchHit[] {
  const terms = buildCjkFallbackTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const where: string[] = terms.map(() => "m.search_text LIKE ?");
  const params: unknown[] = terms.map((term) => `%${term}%`);
  applyFilters(where, params, options);
  const sql = `
SELECT
  m.id, m.session_id, m.seq, m.role,
  substr(m.search_text, 1, 240) AS snippet,
  0 AS rank,
  m.timestamp,
  s.lineage_root_id, s.parent_thread_id, s.title, s.cwd, s.originator,
  s.source_type, s.started_at, s.updated_at,
  f.path AS rollout_path
FROM messages m
JOIN sessions s ON s.session_id = m.session_id
JOIN indexed_files f ON f.id = s.file_id
WHERE ${where.join(" AND ")}
ORDER BY s.source_type = 'subagent', COALESCE(m.timestamp, s.updated_at) DESC
LIMIT ?`;
  return db.prepare<RawSearchHit>(sql).all(...params, clamp(options.scanLimit ?? 300, 1, 5000));
}

function applyFilters(where: string[], params: unknown[], options: SearchOptions): void {
  if (options.roles && options.roles.length > 0) {
    where.push(`m.role IN (${options.roles.map(() => "?").join(", ")})`);
    params.push(...options.roles);
  }
  if (options.cwdPrefix) {
    where.push("s.cwd LIKE ?");
    params.push(`${options.cwdPrefix}%`);
  }
  if (options.since) {
    where.push("COALESCE(m.timestamp, s.updated_at, s.started_at) >= ?");
    params.push(options.since);
  }
  if (options.until) {
    where.push("COALESCE(m.timestamp, s.updated_at, s.started_at) <= ?");
    params.push(options.until);
  }
  if (options.excludeSubagents) {
    where.push("s.source_type <> 'subagent'");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
