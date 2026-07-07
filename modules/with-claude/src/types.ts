import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClaudeBackend } from "./claude-backend.js";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47777;
export const DEFAULT_PROVIDER_ID = "with_claude";
export const DEFAULT_MODEL = "with-claude";

export type AdapterTimeouts = {
  bodyReadMs: number;
  firstOutputMs: number;
  postToolMs: number;
  idleTtlMs: number;
  toolResultTtlMs: number;
  gracefulShutdownMs: number;
  heartbeatMs: number;
};

export const DEFAULT_TIMEOUTS: AdapterTimeouts = {
  bodyReadMs: 10_000,
  firstOutputMs: 90_000,
  postToolMs: 90_000,
  idleTtlMs: 1_800_000,
  toolResultTtlMs: 600_000,
  gracefulShutdownMs: 5_000,
  heartbeatMs: 5_000,
};

export type LogLevel = "debug" | "info" | "warn";

export type AdapterLogger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

export type AdapterServerOptions = {
  host?: "127.0.0.1" | "::1";
  port?: number;
  model?: string;
  providerId?: string;
  backend?: ClaudeBackend;
  logger?: AdapterLogger;
  timeouts?: Partial<AdapterTimeouts>;
  forwardPartialText?: boolean;
  unsafeLogPreviews?: boolean;
};

export type AdapterServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export type CodexResponsesRequest = {
  model?: string;
  instructions?: string;
  input?: unknown;
  tools?: CodexTool[];
  stream?: boolean;
  prompt_cache_key?: string;
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
};

export type CodexFunctionTool = {
  type: "function";
  name?: string;
  description?: string;
  parameters?: unknown;
  input_schema?: unknown;
  [key: string]: unknown;
};

export type CodexTool =
  | CodexFunctionTool
  | { type?: string; name?: string; [key: string]: unknown };

export type BridgeToolDefinition = {
  name: string;
  description: string;
  schema: unknown;
};

export type ResponsesUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export const ZERO_USAGE: ResponsesUsage = {
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
};

export type ResponsesFunctionCall = {
  id: string;
  type: "function_call";
  status: "completed";
  call_id: string;
  name: string;
  arguments: string;
};

export type DiagnosticError = {
  code: string;
  message: string;
};

export type ReplayableSseFrame =
  | { kind: "event"; event: string; data: unknown }
  | { kind: "comment"; comment: string }
  | { kind: "done" };

export type RequestContext = {
  req: IncomingMessage;
  res: ServerResponse;
  body: CodexResponsesRequest;
  sessionKey: string;
  requestId: string;
  inputHash: string;
};

export type InstallOptions = {
  codexHome?: string;
  baseUrl?: string;
  providerId?: string;
  model?: string;
  setDefault?: boolean;
};

export type InstallResult = {
  ok: boolean;
  codexHome: string;
  configPath: string;
  manifestPath: string;
  backupPath: string;
  providerId: string;
  model: string;
  baseUrl: string;
  setDefault: boolean;
};

export type UninstallOptions = {
  codexHome?: string;
  providerId?: string;
  restoreBackup?: string;
};

export type UninstallResult = {
  ok: boolean;
  codexHome: string;
  configPath: string;
  manifestPath?: string;
  backupPath?: string;
  conflict?: string;
};

export type DoctorOptions = {
  codexHome?: string;
  baseUrl?: string;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};
