import type { IncomingMessage } from "node:http";
import { hashString } from "./logging.js";
import { codexJsonSchemaToZod } from "./tool-schema.js";
import type { BridgeToolDefinition, CodexResponsesRequest, CodexTool } from "./types.js";

export type CodexSessionKey = string;

export type SessionKeyParts = {
  threadId?: string;
  sessionId?: string;
  promptCacheKey?: string;
  clientRequestId?: string;
  inputHash: string;
};

export type SessionKeyPolicy = {
  order: Array<keyof Omit<SessionKeyParts, "inputHash"> | "inputHash">;
};

export const DEFAULT_SESSION_KEY_POLICY: SessionKeyPolicy = {
  order: ["threadId", "sessionId", "promptCacheKey", "clientRequestId", "inputHash"],
};

export type RecoveredTranscript = {
  prompt: string;
  userText: string;
  summary: string;
};

export function extractSessionKeyParts(req: IncomingMessage, body: CodexResponsesRequest): SessionKeyParts {
  return {
    threadId: headerString(req.headers["thread-id"]),
    sessionId: headerString(req.headers["session-id"]),
    promptCacheKey: typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
    clientRequestId: headerString(req.headers["x-client-request-id"]),
    inputHash: hashString(JSON.stringify(body.input ?? null)),
  };
}

export function resolveSessionKey(parts: SessionKeyParts, policy: SessionKeyPolicy = DEFAULT_SESSION_KEY_POLICY): CodexSessionKey {
  for (const key of policy.order) {
    const value = parts[key];
    if (value) return value;
  }
  return parts.inputHash;
}

export function requestIdFrom(req: IncomingMessage, parts: SessionKeyParts): string {
  return parts.clientRequestId ?? parts.inputHash;
}

export function recoverPromptFromCodexInput(request: CodexResponsesRequest): RecoveredTranscript {
  const lines: string[] = [];
  if (request.instructions) {
    lines.push("System instructions:", fence(request.instructions));
  }
  const messages: string[] = [];
  const calls = new Map<string, unknown>();
  const outputs: string[] = [];
  const input = Array.isArray(request.input) ? request.input : [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      const role = typeof item.role === "string" ? item.role : "unknown";
      const text = textFromContent(item.content);
      if (text) messages.push(`${role}: ${text}`);
    } else if (item.type === "function_call" && typeof item.call_id === "string") {
      calls.set(item.call_id, {
        name: item.name,
        arguments: item.arguments,
      });
    } else if (item.type === "function_call_output" && typeof item.call_id === "string") {
      outputs.push(JSON.stringify({ call_id: item.call_id, call: calls.get(item.call_id), output: String(item.output ?? "") }).slice(0, 12_000));
    }
  }
  if (messages.length > 0) {
    lines.push("Codex transcript messages:", fence(messages.join("\n\n")));
  }
  if (outputs.length > 0) {
    lines.push("Recovered Codex tool results. Do not call tools again for recovered call_id values; answer from these results unless the latest user request requires a new tool call:", fence(outputs.join("\n")));
  }
  const prompt = lines.join("\n\n").trim() || "Continue the Codex conversation.";
  return {
    prompt,
    userText: messages.at(-1) ?? "",
    summary: `${messages.length} messages, ${outputs.length} recovered tool outputs`,
  };
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractFunctionOutput(request: CodexResponsesRequest): { callId: string; output: string } | undefined {
  const input = Array.isArray(request.input) ? request.input : [];
  for (const item of [...input].reverse()) {
    if (isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string") {
      return { callId: item.call_id, output: String(item.output ?? "") };
    }
  }
  return undefined;
}

export function extractFunctionTools(tools: CodexTool[] | undefined): BridgeToolDefinition[] {
  const out: BridgeToolDefinition[] = [];
  const seen = new Set<string>();
  for (const candidate of tools ?? []) {
    if (candidate.type !== "function") continue;
    const name = candidate.name;
    if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || seen.has(name)) continue;
    const schema = candidate.parameters ?? candidate.input_schema ?? { type: "object", properties: {} };
    // fail-closed는 backend 경계 이전에 적용한다: 변환 불가 스키마는 어떤
    // ClaudeBackend에도 노출되지 않아야 한다 (agent-sdk-backend의 재검사는 이중 방어).
    if (!codexJsonSchemaToZod(schema).ok) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof candidate.description === "string" ? candidate.description : `Codex function tool ${name}`,
      schema,
    });
  }
  return out;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fence(value: string): string {
  return `\`\`\`\n${value.slice(0, 40_000)}\n\`\`\``;
}
