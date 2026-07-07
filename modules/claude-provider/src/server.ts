// Adapted from .work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AgentSdkClaudeBackend } from "./agent-sdk-backend.js";
import type { ClaudeBackend, ClaudeBridgeEvent, ClaudeSession, PendingToolCallView } from "./claude-backend.js";
import {
  extractFunctionOutput,
  extractFunctionTools,
  extractSessionKeyParts,
  recoverPromptFromCodexInput,
  requestIdFrom,
  resolveSessionKey,
} from "./codex-input.js";
import { preview } from "./logging.js";
import { createStderrLogger } from "./logging.js";
import { SseWriter, mapClaudeUsage, replaySse } from "./responses-sse.js";
import { assertAnthropicApiKeyAllowed, rejectBrowserOrigin, validateBindHost, validateHostHeader } from "./security.js";
import { SessionRegistry, timeout, type AdapterSession, type PendingToolCall, type RequestRun } from "./session-registry.js";
import {
  DEFAULT_HOST,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_TIMEOUTS,
  type AdapterServer,
  type AdapterServerOptions,
  type CodexResponsesRequest,
} from "./types.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function createAdapterServer(options: AdapterServerOptions = {}): Promise<AdapterServer> {
  assertAnthropicApiKeyAllowed();
  const host = options.host ?? DEFAULT_HOST;
  validateBindHost(host);
  const port = options.port ?? DEFAULT_PORT;
  const model = options.model ?? DEFAULT_MODEL;
  const logger = options.logger ?? createStderrLogger("info", options.unsafeLogPreviews);
  const timeouts = mergeTimeouts(options.timeouts);
  const backend = options.backend ?? new AgentSdkClaudeBackend();
  const registry = new SessionRegistry();

  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const gate = rejectBrowserOrigin(req) ?? validateHostHeader(req, host, actualPort);
      if (gate) return writeJson(res, gate === "Host header does not match loopback listener" ? 403 : 403, { error: { message: gate } });

      if (req.method === "OPTIONS") return writeJson(res, 403, { error: { message: "CORS preflight is not accepted" } });
      if (req.method === "GET" && req.url === "/healthz") return writeJson(res, 200, { ok: true });
      if (req.method !== "POST" || !req.url?.startsWith("/v1/responses")) return writeJson(res, 404, { error: { message: "not found" } });

      const validation = validateResponseRequestHeaders(req);
      if (validation) return writeJson(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", message: validation } });

      const rawBody = await readBody(req, MAX_BODY_BYTES, timeouts.bodyReadMs);
      const body = parseBody(rawBody);
      if (body.stream !== true) return writeJson(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", message: "stream=true is required" } });

      const parts = extractSessionKeyParts(req, body);
      const sessionKey = resolveSessionKey(parts);
      const requestId = requestIdFrom(req, parts);
      const session = registry.getOrCreate(sessionKey);
      const { run, duplicate } = registry.beginRun(session, requestId, parts.inputHash);
      if (duplicate && duplicate.transcript.length > 0) {
        logger.info("replay_duplicate_request", { sessionKeyHash: preview(sessionKey, false), requestIdHash: preview(requestId, false) });
        return replaySse(res, duplicate.transcript);
      }

      logger.debug("responses_request", {
        sessionKeyHash: preview(sessionKey, false),
        requestIdHash: preview(requestId, false),
        body: preview(rawBody, Boolean(options.unsafeLogPreviews)),
      });

      const functionOutput = extractFunctionOutput(body);
      if (functionOutput) {
        await handleFunctionOutput({ body, model, backend, session, run, writer: new SseWriter(res, { model, transcript: run.transcript }), functionOutput, registry, timeouts });
        return;
      }

      await handleNewQuery({ body, model, backend, session, run, writer: new SseWriter(res, { model, transcript: run.transcript }), timeouts });
    } catch (error) {
      if (!res.headersSent) {
        writeJson(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", message: error instanceof Error ? error.message : String(error) } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  const sweep = setInterval(() => {
    registry.retireExpired(Date.now(), timeouts.toolResultTtlMs);
    registry.sweepIdle(Date.now(), timeouts.idleTtlMs);
  }, 30_000);
  sweep.unref();

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}/v1`;

  return {
    baseUrl,
    async close() {
      clearInterval(sweep);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(force);
          if (error) reject(error);
          else resolve();
        };
        const force = setTimeout(() => {
          server.closeAllConnections();
          finish();
        }, timeouts.gracefulShutdownMs);
        server.close((error) => {
          finish(error ?? undefined);
        });
        server.closeIdleConnections();
      });
    },
  };
}

async function handleNewQuery(args: {
  body: CodexResponsesRequest;
  model: string;
  backend: ClaudeBackend;
  session: AdapterSession;
  run: RequestRun;
  writer: SseWriter;
  timeouts: typeof DEFAULT_TIMEOUTS;
}): Promise<void> {
  const recovered = recoverPromptFromCodexInput(args.body);
  const backendSession = await args.backend.startQuery({
    sessionKey: args.session.key,
    requestId: args.run.requestId,
    model: args.model,
    prompt: recovered.prompt,
    request: args.body,
    tools: extractFunctionTools(args.body.tools),
    toolResultTtlMs: args.timeouts.toolResultTtlMs,
  });
  args.session.activeQuery = backendSession;
  await consumeUntilTerminal(args.session, args.run, backendSession, args.writer, args.body, args.timeouts.firstOutputMs);
}

async function handleFunctionOutput(args: {
  body: CodexResponsesRequest;
  model: string;
  backend: ClaudeBackend;
  session: AdapterSession;
  run: RequestRun;
  writer: SseWriter;
  functionOutput: { callId: string; output: string };
  registry: SessionRegistry;
  timeouts: typeof DEFAULT_TIMEOUTS;
}): Promise<void> {
  const resolved = args.registry.resolvePending(args.session, args.functionOutput.callId, args.functionOutput.output);
  const queued = args.registry.drainQueuedPending(args.session);
  if (queued) {
    args.run.state = "emitted_call";
    emitFunctionCall(args.writer, args.body, queued);
    finishRun(args.run, args.writer);
    return;
  }
  if (resolved) {
    args.run.state = "resolving";
    await consumeUntilTerminal(args.session, args.run, resolved.backendSession, args.writer, args.body, args.timeouts.postToolMs);
    return;
  }

  const recovered = recoverPromptFromCodexInput(args.body);
  const backendSession = await args.backend.startQuery({
    sessionKey: args.session.key,
    requestId: args.run.requestId,
    model: args.model,
    prompt: recovered.prompt,
    request: args.body,
    tools: extractFunctionTools(args.body.tools),
    toolResultTtlMs: args.timeouts.toolResultTtlMs,
  });
  args.session.activeQuery = backendSession;
  await consumeUntilTerminal(args.session, args.run, backendSession, args.writer, args.body, args.timeouts.postToolMs);
}

async function consumeUntilTerminal(
  session: AdapterSession,
  run: RequestRun,
  backendSession: ClaudeSession,
  writer: SseWriter,
  body: CodexResponsesRequest,
  waitMs: number,
): Promise<void> {
  const iterator = session.activeIterator ?? backendSession.events[Symbol.asyncIterator]();
  session.activeIterator = iterator;
  const textParts: string[] = [];
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      timeout(waitMs, { done: false, value: { type: "error", error: { code: "claude_sdk_error", message: "Claude output timeout." } } as ClaudeBridgeEvent }),
    ]);
    if (next.done) {
      const text = textParts.join("").trim() || "Claude completed without text.";
      writer.completeText(body, text);
      run.state = "completed";
      session.activeIterator = undefined;
      finishRun(run, writer);
      return;
    }
    const event = next.value;
    if (event.type === "text_delta") {
      textParts.push(event.text);
      session.textBuffer.push(event.text);
    } else if (event.type === "tool_call") {
      const pending = registerOrQueue(session, backendSession, event.call);
      run.state = "emitted_call";
      emitFunctionCall(writer, body, pending);
      finishRun(run, writer);
      return;
    } else if (event.type === "result") {
      const text = event.text || textParts.join("").trim() || "Claude completed without text.";
      writer.completeText(body, text, mapClaudeUsage(event.usage));
      run.state = "completed";
      void backendSession.close();
      session.activeIterator = undefined;
      finishRun(run, writer);
      return;
    } else {
      writer.completeDiagnosticError(body, { code: event.error.code, message: event.error.message });
      run.state = "failed";
      void backendSession.close();
      session.activeIterator = undefined;
      finishRun(run, writer);
      return;
    }
  }
}

function registerOrQueue(session: AdapterSession, backendSession: ClaudeSession, call: PendingToolCallView): PendingToolCall {
  const pending = { ...call, backendSession };
  if (session.pendingByCallId.size > 0) {
    session.pendingQueue.push(pending);
  } else {
    session.pendingByCallId.set(call.codexCallId, pending);
  }
  return pending;
}

function emitFunctionCall(writer: SseWriter, body: CodexResponsesRequest, pending: PendingToolCall): void {
  writer.completeFunctionCall(body, {
    call_id: pending.codexCallId,
    name: pending.codexToolName,
    arguments: pending.argumentsJson,
  });
}

function finishRun(run: RequestRun, writer: SseWriter): void {
  run.terminalEmitted = writer.terminalEmitted;
  run.terminal.resolve();
}

function validateResponseRequestHeaders(req: IncomingMessage): string | undefined {
  const contentType = req.headers["content-type"];
  if (!String(contentType ?? "").toLowerCase().includes("application/json")) return "content-type application/json is required";
  const accept = req.headers.accept;
  if (!String(accept ?? "").toLowerCase().includes("text/event-stream")) return "accept text/event-stream is required";
  return undefined;
}

function parseBody(rawBody: string): CodexResponsesRequest {
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed as CodexResponsesRequest;
}

function readBody(req: IncomingMessage, limitBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("request body timeout"));
    }, timeoutMs);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function mergeTimeouts(overrides: AdapterServerOptions["timeouts"]): typeof DEFAULT_TIMEOUTS {
  const merged = { ...DEFAULT_TIMEOUTS };
  for (const [key, value] of Object.entries(overrides ?? {}) as Array<[keyof typeof DEFAULT_TIMEOUTS, number | undefined]>) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}
