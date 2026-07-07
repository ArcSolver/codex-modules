import type { BridgeToolDefinition, CodexResponsesRequest } from "./types.js";

export type PendingToolCallView = {
  codexCallId: string;
  codexToolName: string;
  argumentsJson: string;
  createdAt: number;
};

export type ClaudeBackendError = {
  code: string;
  message: string;
  cause?: unknown;
};

export type ClaudeStartOptions = {
  sessionKey: string;
  requestId: string;
  model: string;
  prompt: string;
  request: CodexResponsesRequest;
  tools: BridgeToolDefinition[];
  toolResultTtlMs: number;
  maxTurns?: number;
};

export type ClaudeBridgeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: PendingToolCallView }
  | { type: "result"; text: string; usage?: unknown }
  | { type: "error"; error: ClaudeBackendError };

export interface ClaudeBackend {
  startQuery(options: ClaudeStartOptions): Promise<ClaudeSession>;
}

export interface ClaudeSession {
  events: AsyncIterable<ClaudeBridgeEvent>;
  resolveTool(callId: string, output: string): Promise<void>;
  cancel(reason: string): Promise<void>;
  close(): Promise<void>;
}
