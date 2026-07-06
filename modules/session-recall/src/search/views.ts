import { resolveRecallPaths } from "../paths.js";
import { openReadonlyDatabase } from "../db/better-sqlite3.js";
import type { AroundOptions, AroundPayload, ReadOptions, ReadPayload, ShapedMessage } from "../types.js";
import type { SqlDatabase } from "../db/adapter.js";

interface MessageRow {
  seq: number;
  role: string;
  text?: string;
  timestamp?: string;
  tool_name?: string;
  truncated: number;
  line_no: number;
}

export function getMessagesAround(db: SqlDatabase, sessionId: string, seq: number, window: number): AroundPayload {
  const normalizedWindow = clamp(window, 1, 20);
  const anchor = resolveAnchorSeq(db, sessionId, seq);
  const before = db
    .prepare<MessageRow>(
      `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
       FROM messages
       WHERE session_id = ? AND seq <= ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(sessionId, anchor, normalizedWindow + 1)
    .reverse();
  const after = db
    .prepare<MessageRow>(
      `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
       FROM messages
       WHERE session_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(sessionId, anchor, normalizedWindow);
  const rows = [...before, ...after];
  return {
    success: true,
    mode: "around",
    session_id: sessionId,
    anchor_ref: anchor,
    messages: rows.map((row) => shapeMessage(row, row.seq === anchor)),
    messages_before: before.filter((row) => row.seq < anchor).length,
    messages_after: after.length,
    warnings: [],
  };
}

export function getAnchoredView(
  db: SqlDatabase,
  sessionId: string,
  seq: number,
  options: { window: number; bookend: number },
): { bookend_start: ShapedMessage[]; messages: ShapedMessage[]; bookend_end: ShapedMessage[]; messages_before: number; messages_after: number } {
  const around = getMessagesAround(db, sessionId, seq, options.window);
  const bookend = clamp(options.bookend, 0, 10);
  const windowSeqs = new Set(around.messages.map((message) => message.seq));
  const startRows = bookendRows(db, sessionId, "ASC", bookend).filter((row) => !windowSeqs.has(row.seq));
  const endRows = bookendRows(db, sessionId, "DESC", bookend)
    .reverse()
    .filter((row) => !windowSeqs.has(row.seq));
  return {
    bookend_start: startRows.map((row) => shapeMessage(row, false)),
    messages: around.messages,
    bookend_end: endRows.map((row) => shapeMessage(row, false)),
    messages_before: around.messages_before,
    messages_after: around.messages_after,
  };
}

export function readSession(db: SqlDatabase, sessionId: string, options: { head?: number; tail?: number; full?: boolean }): ReadPayload {
  const count =
    db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?").get(sessionId)?.count ?? 0;
  if (count === 0) {
    throw new Error(`No indexed messages found for session ${sessionId}`);
  }
  const head = clamp(options.head ?? 20, 1, 200);
  const tail = clamp(options.tail ?? 10, 0, 200);
  const full = options.full || count <= head + tail;
  let rows: MessageRow[];
  if (full) {
    rows = db
      .prepare<MessageRow>(
        `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
         FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId);
  } else {
    const headRows = db
      .prepare<MessageRow>(
        `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
         FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, head);
    const tailRows = db
      .prepare<MessageRow>(
        `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
         FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, tail)
      .reverse();
    const seen = new Set<number>();
    rows = [...headRows, ...tailRows].filter((row) => {
      if (seen.has(row.seq)) {
        return false;
      }
      seen.add(row.seq);
      return true;
    });
  }
  return {
    success: true,
    mode: "read",
    session_id: sessionId,
    message_count: count,
    messages: rows.map((row) => shapeMessage(row, false)),
    truncated: !full,
    omitted_count: full ? 0 : Math.max(0, count - rows.length),
    warnings: full ? [] : [`Session is truncated; use around ${sessionId} <msg-ref> to inspect the middle.`],
  };
}

export async function around(options: { sessionId: string; msgRef: string } & AroundOptions): Promise<AroundPayload> {
  const paths = resolveRecallPaths(options);
  const db = openReadonlyDatabase(paths.dbPath);
  try {
    const ref = parseMsgRef(options.msgRef);
    const seq = ref.kind === "line" ? resolveLineRef(db, options.sessionId, ref.value) : ref.value;
    return getMessagesAround(db, options.sessionId, seq, options.window ?? 5);
  } finally {
    db.close();
  }
}

export async function read(options: { sessionId: string } & ReadOptions): Promise<ReadPayload> {
  const paths = resolveRecallPaths(options);
  const db = openReadonlyDatabase(paths.dbPath);
  try {
    return readSession(db, options.sessionId, options);
  } finally {
    db.close();
  }
}

export function parseMsgRef(ref: string): { kind: "seq" | "line"; value: number } {
  const normalized = ref.startsWith("#") ? ref.slice(1) : ref;
  if (normalized.startsWith("line:")) {
    const line = Number(normalized.slice("line:".length));
    if (!Number.isInteger(line) || line < 1) {
      throw new Error(`Invalid line msg-ref: ${ref}`);
    }
    return { kind: "line", value: line };
  }
  const seq = Number(normalized);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`Invalid msg-ref: ${ref}`);
  }
  return { kind: "seq", value: seq };
}

function resolveAnchorSeq(db: SqlDatabase, sessionId: string, ref: number): number {
  const bySeq = db.prepare<{ seq: number }>("SELECT seq FROM messages WHERE session_id = ? AND seq = ?").get(sessionId, ref);
  if (bySeq) {
    return bySeq.seq;
  }
  const byLine = db.prepare<{ seq: number }>("SELECT seq FROM messages WHERE session_id = ? AND line_no = ?").get(sessionId, ref);
  if (byLine) {
    return byLine.seq;
  }
  throw new Error(`Message ref ${ref} was not found in session ${sessionId}`);
}

function resolveLineRef(db: SqlDatabase, sessionId: string, lineNo: number): number {
  const byLine = db.prepare<{ seq: number }>("SELECT seq FROM messages WHERE session_id = ? AND line_no = ?").get(sessionId, lineNo);
  if (!byLine) {
    throw new Error(`Line ref ${lineNo} was not found in session ${sessionId}`);
  }
  return byLine.seq;
}

function bookendRows(db: SqlDatabase, sessionId: string, direction: "ASC" | "DESC", limit: number): MessageRow[] {
  if (limit <= 0) {
    return [];
  }
  return db
    .prepare<MessageRow>(
      `SELECT seq, role, text, timestamp, tool_name, truncated, line_no
       FROM messages
       WHERE session_id = ? AND role IN ('user', 'assistant') AND COALESCE(text, '') <> ''
       ORDER BY seq ${direction}
       LIMIT ?`,
    )
    .all(sessionId, limit);
}

function shapeMessage(row: MessageRow, anchor: boolean): ShapedMessage {
  return {
    seq: row.seq,
    role: row.role as ShapedMessage["role"],
    content: row.text ?? "",
    timestamp: row.timestamp,
    tool_name: row.tool_name,
    anchor: anchor || undefined,
    truncated: row.truncated === 1 || undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
