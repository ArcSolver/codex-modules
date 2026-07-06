import type { MessageRole, ParsedMessage } from "../types.js";

const DISPLAY_TEXT_LIMIT = 20_000;
const SEARCH_TEXT_LIMIT = 100_000;

const EXCLUDED_EVENT_TYPES = new Set([
  "token_count",
  "mcp_tool_call_end",
  "patch_apply_end",
  "task_started",
  "task_complete",
  "turn_aborted",
  "context_compacted",
  "image_generation_end",
  "thread_rolled_back",
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function extractText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((part) => extractText(part)).filter(Boolean).join("\n");
  }
  if (!isObject(value)) {
    return "";
  }

  const direct = ["message", "text", "output", "content", "arguments", "input", "summary"];
  for (const key of direct) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  if (Array.isArray(value.content)) {
    return extractText(value.content);
  }
  if (isObject(value.item)) {
    return extractText(value.item);
  }
  if (typeof value.type === "string" && typeof value.text === "string") {
    return value.text;
  }
  return "";
}

export function extractContentParts(payload: Record<string, unknown>): string {
  const candidates = [
    payload.message,
    payload.text,
    payload.content,
    isObject(payload.item) ? payload.item.content : undefined,
    payload.output,
    payload.arguments,
    payload.input,
  ];
  return candidates.map((candidate) => extractText(candidate)).find((text) => text.trim().length > 0) ?? "";
}

export function extractToolName(payload: Record<string, unknown>): string | undefined {
  const item = isObject(payload.item) ? payload.item : undefined;
  return (
    stringValue(payload.name) ??
    stringValue(payload.tool_name) ??
    stringValue(payload.toolName) ??
    (item ? stringValue(item.name) : undefined) ??
    (item ? stringValue(item.tool_name) : undefined)
  );
}

export function extractCallId(payload: Record<string, unknown>): string | undefined {
  const item = isObject(payload.item) ? payload.item : undefined;
  return stringValue(payload.call_id) ?? stringValue(payload.callId) ?? (item ? stringValue(item.call_id) : undefined);
}

export function extractTurnId(payload: Record<string, unknown>): string | undefined {
  return stringValue(payload.turn_id) ?? stringValue(payload.turnId);
}

export function extractTimestamp(payload: Record<string, unknown>, line: Record<string, unknown>): string | undefined {
  return stringValue(payload.timestamp) ?? stringValue(payload.created_at) ?? stringValue(line.timestamp) ?? stringValue(line.ts);
}

export function normalizeRole(lineType: string, payloadType: string, payload: Record<string, unknown>): MessageRole | null {
  if (lineType === "event_msg") {
    if (payloadType === "user_message") {
      return "user";
    }
    if (payloadType === "agent_message") {
      return "assistant";
    }
    if (EXCLUDED_EVENT_TYPES.has(payloadType)) {
      return null;
    }
    return null;
  }

  if (lineType !== "response_item") {
    return null;
  }

  if (payloadType === "message") {
    const role = stringValue(payload.role);
    if (role === "user" || role === "assistant" || role === "system") {
      return role;
    }
    return "assistant";
  }
  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    return "function";
  }
  if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
    return "tool";
  }
  if (payloadType === "reasoning") {
    return null;
  }
  return null;
}

export function truncateForIndex(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

export function buildSearchText(message: Omit<ParsedMessage, "searchText">): string {
  return [message.role, message.toolName, message.text].filter(Boolean).join(" ");
}

export function normalizeTextForMessage(rawText: string): { displayText: string; searchText: string; truncated: boolean } {
  const display = truncateForIndex(rawText, DISPLAY_TEXT_LIMIT);
  const search = truncateForIndex(rawText, SEARCH_TEXT_LIMIT);
  return {
    displayText: display.text,
    searchText: search.text,
    truncated: display.truncated || search.truncated,
  };
}
