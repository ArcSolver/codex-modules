// Adapted from .work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeBackend, ClaudeBridgeEvent, ClaudeSession, ClaudeStartOptions, PendingToolCallView } from "./claude-backend.js";
import { safe, shortHash } from "./logging.js";
import { buildScrubbedClaudeEnv } from "./security.js";
import { codexJsonSchemaToZod } from "./tool-schema.js";

type Resolver = {
  resolve(output: string): void;
  reject(error: Error): void;
};

export class AgentSdkClaudeBackend implements ClaudeBackend {
  async startQuery(options: ClaudeStartOptions): Promise<ClaudeSession> {
    return new AgentSdkClaudeSession(options);
  }
}

class AgentSdkClaudeSession implements ClaudeSession {
  private readonly queue = new AsyncQueue<ClaudeBridgeEvent>();
  private readonly resolvers = new Map<string, Resolver>();
  private readonly abortController = new AbortController();
  private closed = false;
  private counter = 0;
  readonly events: AsyncIterable<ClaudeBridgeEvent> = this.queue;

  constructor(private readonly startOptions: ClaudeStartOptions) {
    this.start();
  }

  async resolveTool(callId: string, output: string): Promise<void> {
    const resolver = this.resolvers.get(callId);
    if (!resolver) return;
    this.resolvers.delete(callId);
    resolver.resolve(output);
  }

  async cancel(reason: string): Promise<void> {
    for (const [callId, resolver] of this.resolvers) {
      this.resolvers.delete(callId);
      resolver.reject(new Error(reason));
    }
    this.abortController.abort(reason);
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort("closed");
    this.queue.close();
  }

  private start(): void {
    const tools = this.startOptions.tools.map((definition) => {
      const converted = codexJsonSchemaToZod(definition.schema);
      if (!converted.ok) return undefined;
      return tool(
        definition.name,
        definition.description,
        converted.schema as never,
        async (args: unknown): Promise<CallToolResult> => {
          const call = this.createCall(definition.name, JSON.stringify(safe(args) ?? {}));
          this.queue.push({ type: "tool_call", call });
          const output = await this.waitForToolOutput(call.codexCallId);
          return {
            content: [{ type: "text", text: output }],
            structuredContent: { output },
          };
        },
        { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
      );
    }).filter(Boolean);

    const allowedTools = this.startOptions.tools
      .filter((definition) => codexJsonSchemaToZod(definition.schema).ok)
      .map((definition) => `mcp__codex_bridge__${definition.name}`);

    const bridgeServer = createSdkMcpServer({
      name: "codex_bridge",
      version: "0.1.0",
      tools: tools as never[],
    });

    const sdkQuery = query({
      prompt: [
        "You are the model backend for Codex.",
        "Use only the provided codex_bridge MCP tools when a local action is required.",
        "Never claim a tool result before a codex_bridge tool has returned it.",
        "",
        this.startOptions.prompt,
      ].join("\n"),
      options: {
        abortController: this.abortController,
        settingSources: [],
        tools: [],
        mcpServers: { codex_bridge: bridgeServer },
        allowedTools,
        permissionMode: "dontAsk",
        maxTurns: this.startOptions.maxTurns ?? 6,
        env: buildScrubbedClaudeEnv({
          allowAnthropicApiKey: process.env.ALLOW_ANTHROPIC_API_KEY === "1",
          streamCloseTimeoutMs: this.startOptions.toolResultTtlMs + 60_000,
        }),
      },
    });

    void (async () => {
      try {
        let lastUsage: unknown;
        const textParts: string[] = [];
        for await (const message of sdkQuery) {
          const event = safe(message) as Record<string, unknown>;
          if (event.type === "assistant") {
            const content = isRecord(event.message) && Array.isArray(event.message.content) ? event.message.content : [];
            for (const block of content) {
              if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
                textParts.push(block.text);
                this.queue.push({ type: "text_delta", text: block.text });
              }
            }
          } else if (event.type === "result") {
            lastUsage = event.usage;
            const result = typeof event.result === "string" ? event.result : textParts.join("");
            this.queue.push({ type: "result", text: result, usage: lastUsage });
          } else if (event.type === "rate_limit_event") {
            continue;
          }
        }
      } catch (error) {
        if (!this.closed) {
          this.queue.push({ type: "error", error: mapSdkError(error) });
        }
      } finally {
        this.queue.close();
        sdkQuery.close();
      }
    })();
  }

  private createCall(toolName: string, argumentsJson: string): PendingToolCallView {
    this.counter += 1;
    return {
      codexCallId: `${shortHash(this.startOptions.sessionKey)}-${this.counter}`,
      codexToolName: toolName,
      argumentsJson,
      createdAt: Date.now(),
    };
  }

  private waitForToolOutput(callId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolvers.set(callId, { resolve, reject });
    });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function mapSdkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const code =
    lower.includes("auth") || lower.includes("login") ? "claude_authentication_failed" :
    lower.includes("oauth") ? "claude_oauth_org_not_allowed" :
    lower.includes("billing") ? "claude_billing_error" :
    lower.includes("rate") ? "claude_rate_limit" :
    lower.includes("overload") ? "claude_overloaded" :
    lower.includes("model") ? "claude_model_not_found" :
    lower.includes("invalid") ? "claude_invalid_request" :
    lower.includes("max_output") ? "claude_max_output_tokens" :
    "claude_sdk_error";
  return { code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
