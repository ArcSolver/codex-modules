import path from "node:path";
import type { ParsedMessage, ParsedRollout, ParsedSession, SourceType } from "../types.js";
import { readJsonl, type JsonlLine } from "./jsonl.js";
import {
  buildSearchText,
  extractCallId,
  extractContentParts,
  extractTimestamp,
  extractToolName,
  extractTurnId,
  isObject,
  normalizeRole,
  normalizeTextForMessage,
  stringValue,
} from "./normalize.js";

export interface ParseOptions {
  sessionId?: string;
  cwdPrefix?: string;
  excludeSubagents?: boolean;
  includeReasoning?: boolean;
  excludeToolOutput?: boolean;
}

export async function parseRolloutFile(filePath: string, options: ParseOptions = {}): Promise<ParsedRollout> {
  const lines: JsonlLine[] = [];
  const warnings: string[] = [];

  for await (const line of readJsonl(filePath)) {
    if (isObject(line.value) && typeof line.value.__parse_error === "string") {
      warnings.push(`${filePath}:${line.lineNo}: JSON parse failed: ${line.value.__parse_error}`);
      continue;
    }
    lines.push(line);
  }

  const session = parseSessionMeta(lines, filePath);
  if (options.sessionId && session.sessionId !== options.sessionId && session.threadId !== options.sessionId) {
    return { session, messages: [], warnings: [...warnings, `session ${session.sessionId} did not match filter`] };
  }
  if (options.cwdPrefix && (!session.cwd || !session.cwd.startsWith(options.cwdPrefix))) {
    return { session, messages: [], warnings: [...warnings, `session ${session.sessionId} did not match cwd filter`] };
  }
  if (options.excludeSubagents && session.sourceType === "subagent") {
    return { session, messages: [], warnings: [...warnings, `session ${session.sessionId} excluded as subagent`] };
  }

  const messages: ParsedMessage[] = [];
  let seq = 0;
  for (const line of lines) {
    const normalized = normalizeRolloutLine(line, options, seq + 1);
    if (normalized) {
      seq += 1;
      messages.push(normalized);
    }
  }
  return { session, messages, warnings };
}

export function parseSessionMeta(lines: JsonlLine[], filePath: string): ParsedSession {
  const metaLine = lines.find((line) => isObject(line.value) && line.value.type === "session_meta");
  const line = isObject(metaLine?.value) ? metaLine.value : undefined;
  const payload = isObject(line?.payload) ? line.payload : {};
  const source = isObject(payload.source) ? payload.source : {};
  const subagent = isObject(source.subagent) ? source.subagent : undefined;
  const threadSpawn = isObject(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
  const fallbackSessionId = parseSessionIdFromPath(filePath);
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.id) ?? fallbackSessionId;
  const threadId = stringValue(payload.id) ?? sessionId;
  const parentThreadId =
    stringValue(payload.parent_thread_id) ??
    stringValue(payload.forked_from_id) ??
    (threadSpawn ? stringValue(threadSpawn.parent_thread_id) : undefined);
  const sourceType: SourceType = threadSpawn ? "subagent" : "interactive";
  const startedAt = parseRolloutTimestampFromPath(filePath) ?? stringValue(payload.started_at) ?? stringValue(payload.created_at);

  return {
    sessionId,
    threadId,
    parentThreadId,
    forkedFromId: stringValue(payload.forked_from_id),
    lineageRootId: parentThreadId ?? sessionId,
    sourceType,
    subagentDepth: threadSpawn ? numberValue(threadSpawn.depth) : undefined,
    originator: stringValue(payload.originator),
    cliVersion: stringValue(payload.cli_version),
    cwd: stringValue(payload.cwd),
    model: stringValue(payload.model),
    title: stringValue(payload.thread_name) ?? stringValue(payload.title),
    startedAt,
    updatedAt: stringValue(payload.updated_at) ?? startedAt,
    metaJson: JSON.stringify(payload),
  };
}

export function normalizeRolloutLine(line: JsonlLine, options: ParseOptions, seq: number): ParsedMessage | null {
  if (!isObject(line.value)) {
    return null;
  }
  const lineType = stringValue(line.value.type);
  if (lineType !== "event_msg" && lineType !== "response_item") {
    return null;
  }
  const payload = isObject(line.value.payload) ? line.value.payload : {};
  const payloadType = stringValue(payload.type) ?? "unknown";
  if (payloadType === "reasoning" && !options.includeReasoning) {
    return null;
  }
  if ((payloadType === "function_call_output" || payloadType === "custom_tool_call_output") && options.excludeToolOutput) {
    return null;
  }
  const role = normalizeRole(lineType, payloadType, payload);
  if (!role) {
    return null;
  }

  const toolName = extractToolName(payload);
  const rawText = extractContentParts(payload);
  const rendered = normalizeTextForMessage(rawText);
  const base: Omit<ParsedMessage, "searchText"> = {
    seq,
    lineNo: line.lineNo,
    lineType,
    payloadType,
    role,
    text: rendered.displayText,
    toolName,
    callId: extractCallId(payload),
    turnId: extractTurnId(payload),
    timestamp: extractTimestamp(payload, line.value),
    truncated: rendered.truncated,
    rawKind: payloadType,
  };
  const searchText = buildSearchText({ ...base, text: rendered.searchText });
  if (searchText.trim().length === 0) {
    return null;
  }
  return { ...base, searchText };
}

function parseSessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  const match = base.match(/^rollout-.+-(.+)$/);
  return match?.[1] ?? base;
}

function parseRolloutTimestampFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  const match = base.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)-/);
  if (!match) {
    return undefined;
  }
  return match[1].replace("T", "T").replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
