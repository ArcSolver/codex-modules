import fs from "node:fs";

const DEFAULT_USAGE = {
  input_tokens: 11,
  output_tokens: 7,
  total_tokens: 18
};

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function detectScenario(options) {
  const haystack = collectStrings(options).join("\n");
  if (haystack.includes("[[fake:multi-tool]]")) return "multi-tool";
  if (haystack.includes("[[fake:instant-result]]")) return "instant-result";
  if (haystack.includes("[[fake:error]]")) return "error";
  if (haystack.includes("[[fake:tool-once]]")) return "tool-once";
  if (/\bexec_command\b/.test(haystack) && /\bpwd\b|\bworkspace path\b/i.test(haystack)) {
    return "tool-once";
  }
  return "message-only";
}

function collectToolNames(startOptions) {
  // Claude에 노출되는 카탈로그는 ClaudeStartOptions.tools가 유일한 계약이다.
  // raw request(startOptions.request)를 깊이 순회하면 어댑터가 fail-closed로
  // 걸러낸 tool 이름까지 주워 담아 오탐을 만든다.
  const out = new Set();
  for (const tool of startOptions?.tools ?? []) {
    if (typeof tool?.name === "string") out.add(tool.name);
  }
  return out;
}

function firstSupportedTool(options) {
  const names = collectToolNames(options);
  for (const name of names) {
    if (name && !name.startsWith("unsupported_") && name !== "web_search") {
      return name;
    }
  }
  return "exec_command";
}

function makePendingCall(sessionId, index, name, args) {
  const callId = `${sessionId}-call-${index}`;
  return {
    id: callId,
    callId,
    call_id: callId,
    codexCallId: callId,
    name,
    toolName: name,
    codexToolName: name,
    createdAt: Date.now(),
    arguments: JSON.stringify(args),
    argumentsJson: JSON.stringify(args),
    args,
    toolArgs: args,
    input: args
  };
}

class FakeClaudeSession {
  constructor({ id, scenario, toolName, trace }) {
    this.id = id;
    this.scenario = scenario;
    this.toolName = toolName;
    this.trace = trace;
    this.queue = new AsyncQueue();
    this.events = this.queue;
    this.pending = new Map();
    this.resolved = [];
    this.closed = false;

    queueMicrotask(() => this.start());
  }

  start() {
    if (this.closed) return;
    if (this.scenario === "error") {
      this.queue.push({
        type: "error",
        error: {
          code: "fake_error",
          message: "Synthetic fake backend error"
        }
      });
      this.queue.end();
      return;
    }

    if (this.scenario === "instant-result" || this.scenario === "message-only") {
      this.queue.push({ type: "text_delta", text: "synthetic " });
      this.queue.push({
        type: "result",
        text: "synthetic final response",
        usage: DEFAULT_USAGE
      });
      this.queue.end();
      return;
    }

    const count = this.scenario === "multi-tool" ? 2 : 1;
    for (let index = 1; index <= count; index += 1) {
      const args = index === 1 ? { cmd: "pwd" } : { cmd: "printf second" };
      const call = makePendingCall(this.id, index, this.toolName, args);
      this.pending.set(call.callId, call);
      this.queue.push({ type: "tool_call", call });
    }
  }

  async resolveTool(callId, output) {
    const exact = this.pending.get(callId);
    const fallbackKey = exact ? callId : this.pending.keys().next().value;
    const call = exact ?? this.pending.get(fallbackKey);
    if (!call) {
      this.trace("backend_resolve_tool_unknown", { sessionId: this.id, callId });
      return;
    }

    this.pending.delete(fallbackKey);
    this.resolved.push({ expectedCallId: fallbackKey, receivedCallId: callId, output });
    this.trace("backend_resolve_tool", {
      sessionId: this.id,
      expectedCallId: fallbackKey,
      receivedCallId: callId,
      outputLength: String(output ?? "").length
    });

    if (this.pending.size === 0 && !this.closed) {
      const finalText = this.resolved.length === 1
        ? String(output ?? "").trim() || "synthetic tool output received"
        : `resolved ${this.resolved.length} synthetic tool calls`;
      this.queue.push({
        type: "result",
        text: finalText,
        usage: {
          input_tokens: 23,
          output_tokens: 5,
          total_tokens: 28
        }
      });
      this.queue.end();
    }
  }

  async cancel(reason) {
    this.trace("backend_cancel", { sessionId: this.id, reason });
    this.closed = true;
    this.queue.end();
  }

  async close() {
    this.trace("backend_close", { sessionId: this.id });
    this.closed = true;
    this.queue.end();
  }
}

export function createFakeClaudeBackend(options = {}) {
  let nextSession = 1;
  const tracePath = options.tracePath ?? process.env.FAKE_CLAUDE_TRACE ?? "";

  function trace(type, payload = {}) {
    if (!tracePath) return;
    fs.appendFileSync(
      tracePath,
      `${JSON.stringify({ type, at: new Date().toISOString(), ...payload })}\n`
    );
  }

  return {
    async startQuery(startOptions = {}) {
      const id = `fake-session-${nextSession}`;
      nextSession += 1;
      const scenario = options.scenario ?? detectScenario(startOptions);
      const toolName = options.toolName ?? firstSupportedTool(startOptions);
      trace("backend_start_query", {
        sessionId: id,
        scenario,
        toolName,
        toolNames: Array.from(collectToolNames(startOptions)).sort(),
        optionsPreview: safeJson(startOptions).slice(0, 600)
      });
      return new FakeClaudeSession({ id, scenario, toolName, trace });
    }
  };
}

export const fakeBackend = createFakeClaudeBackend();
