export type SourceType = "interactive" | "subagent" | "unknown";
export type MessageRole = "user" | "assistant" | "function" | "tool" | "system";
export type SearchSort = "relevance" | "newest" | "oldest";

export interface RecallPaths {
  codexHome: string;
  stateDir: string;
  dbPath: string;
}

export interface SyncOptions {
  codexHome?: string;
  stateDir?: string;
  since?: string;
  until?: string;
  cwdPrefix?: string;
  sessionId?: string;
  path?: string;
  includeArchived?: boolean;
  excludeSubagents?: boolean;
  rebuild?: boolean;
  dryRun?: boolean;
  includeReasoning?: boolean;
  excludeToolOutput?: boolean;
  debugPaths?: boolean;
}

export interface SearchOptions {
  stateDir?: string;
  limit?: number;
  scanLimit?: number;
  sort?: SearchSort;
  window?: number;
  bookend?: number;
  roles?: MessageRole[];
  cwdPrefix?: string;
  since?: string;
  until?: string;
  excludeSubagents?: boolean;
  debugPaths?: boolean;
}

export interface ReadOptions {
  stateDir?: string;
  head?: number;
  tail?: number;
  full?: boolean;
  debugPaths?: boolean;
}

export interface AroundOptions {
  stateDir?: string;
  window?: number;
  debugPaths?: boolean;
}

export interface ShapedMessage {
  seq: number;
  role: MessageRole;
  content: string;
  timestamp?: string;
  tool_name?: string;
  anchor?: boolean;
  truncated?: boolean;
  line_no?: number;
}

export interface ParsedSession {
  sessionId: string;
  threadId?: string;
  parentThreadId?: string;
  forkedFromId?: string;
  lineageRootId: string;
  sourceType: SourceType;
  subagentDepth?: number;
  originator?: string;
  cliVersion?: string;
  cwd?: string;
  model?: string;
  title?: string;
  startedAt?: string;
  updatedAt?: string;
  metaJson: string;
}

export interface ParsedMessage {
  seq: number;
  lineNo: number;
  lineType: "event_msg" | "response_item";
  payloadType: string;
  role: MessageRole;
  text: string;
  searchText: string;
  toolName?: string;
  callId?: string;
  turnId?: string;
  timestamp?: string;
  truncated: boolean;
  rawKind?: string;
}

export interface ParsedRollout {
  session: ParsedSession;
  messages: ParsedMessage[];
  warnings: string[];
}

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  sourceBucket: "sessions" | "archived_sessions" | "explicit_path";
}

export interface SyncResult {
  success: boolean;
  mode: "sync";
  stateDir: string;
  dbPath?: string;
  files: {
    indexed: number;
    updated: number;
    unchanged: number;
    deleted: number;
  };
  sessions: {
    inserted: number;
    updated: number;
  };
  messages: {
    inserted: number;
    updated: number;
  };
  dryRun?: boolean;
  warnings: string[];
}

export interface SearchResult {
  session_id: string;
  lineage_root_id: string;
  parent_thread_id?: string;
  title?: string;
  cwd?: string;
  originator?: string;
  source_type: SourceType;
  started_at?: string;
  updated_at?: string;
  matched_role: MessageRole;
  match_message_ref: number;
  snippet: string;
  bookend_start: ShapedMessage[];
  messages: ShapedMessage[];
  bookend_end: ShapedMessage[];
  messages_before: number;
  messages_after: number;
  rollout_path?: string;
}

export interface SearchResultPayload {
  success: boolean;
  mode: "search";
  query: string;
  count: number;
  results: SearchResult[];
  warnings: string[];
}

export interface AroundPayload {
  success: boolean;
  mode: "around";
  session_id: string;
  anchor_ref: number;
  messages: ShapedMessage[];
  messages_before: number;
  messages_after: number;
  warnings: string[];
}

export interface ReadPayload {
  success: boolean;
  mode: "read";
  session_id: string;
  message_count: number;
  messages: ShapedMessage[];
  truncated: boolean;
  omitted_count: number;
  warnings: string[];
}
