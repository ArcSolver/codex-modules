// Adapted from .work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs
import type { ServerResponse } from "node:http";
import type {
  CodexResponsesRequest,
  DiagnosticError,
  ReplayableSseFrame,
  ResponsesFunctionCall,
  ResponsesUsage,
} from "./types.js";
import { ZERO_USAGE } from "./types.js";

export type SseWriterOptions = {
  model: string;
  transcript?: ReplayableSseFrame[];
};

export class SseWriter {
  readonly transcript: ReplayableSseFrame[];
  private responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  private itemCounter = 0;
  private started = false;
  terminalEmitted = false;

  constructor(private readonly res: ServerResponse, private readonly options: SseWriterOptions) {
    this.transcript = options.transcript ?? [];
  }

  start(request: CodexResponsesRequest, output: unknown[] = []): void {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    this.emit("response.created", {
      type: "response.created",
      response: { ...baseResponse(request, this.options.model, output, this.responseId, ZERO_USAGE), output: [] },
    });
  }

  heartbeat(): void {
    this.transcript.push({ kind: "comment", comment: "keep-alive" });
    this.res.write(": keep-alive\n\n");
  }

  completeText(request: CodexResponsesRequest, text: string, usage: ResponsesUsage = ZERO_USAGE): void {
    this.start(request);
    const output = textOutput(text, this.nextItemId("msg"));
    const part = output.content[0];
    const payload = baseResponse(request, this.options.model, [output], this.responseId, usage);
    this.emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } });
    this.emit("response.content_part.added", { type: "response.content_part.added", output_index: 0, content_index: 0, part: { ...part, text: "" } });
    this.emit("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
    this.emit("response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0, text });
    this.emit("response.content_part.done", { type: "response.content_part.done", output_index: 0, content_index: 0, part });
    this.emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: output });
    this.emit("response.completed", { type: "response.completed", response: payload });
    this.done();
  }

  completeFunctionCall(request: CodexResponsesRequest, call: Omit<ResponsesFunctionCall, "id" | "type" | "status">, usage: ResponsesUsage = ZERO_USAGE): void {
    const item: ResponsesFunctionCall = {
      id: this.nextItemId("fc"),
      type: "function_call",
      status: "completed",
      ...call,
    };
    this.start(request);
    const payload = baseResponse(request, this.options.model, [item], this.responseId, usage);
    this.emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
    this.emit("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: payload.id,
      item_id: item.id,
      output_index: 0,
      call_id: item.call_id,
      delta: item.arguments,
    });
    this.emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: payload.id,
      item_id: item.id,
      output_index: 0,
      call_id: item.call_id,
      arguments: item.arguments,
    });
    this.emit("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
    this.emit("response.completed", { type: "response.completed", response: payload });
    this.done();
  }

  completeDiagnosticError(request: CodexResponsesRequest, error: DiagnosticError): void {
    this.completeText(request, `[claude-provider error: ${error.code}] ${error.message}`, ZERO_USAGE);
  }

  done(): void {
    if (this.terminalEmitted) return;
    this.terminalEmitted = true;
    this.transcript.push({ kind: "done" });
    this.res.write("data: [DONE]\n\n");
    this.res.end();
  }

  emit(event: string, data: unknown): void {
    this.transcript.push({ kind: "event", event, data });
    this.res.write(`event: ${event}\n`);
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  private nextItemId(prefix: string): string {
    this.itemCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${this.itemCounter}`;
  }
}

export function replaySse(res: ServerResponse, frames: ReplayableSseFrame[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const frame of frames) {
    if (frame.kind === "event") {
      res.write(`event: ${frame.event}\n`);
      res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
    } else if (frame.kind === "comment") {
      res.write(`: ${frame.comment}\n\n`);
    } else {
      res.write("data: [DONE]\n\n");
    }
  }
  res.end();
}

export function baseResponse(request: CodexResponsesRequest, model: string, output: unknown[], id: string, usage: ResponsesUsage) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: request.model ?? model,
    output,
    usage,
  };
}

export function textOutput(text: string, id: string) {
  return {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function mapClaudeUsage(usage: unknown): ResponsesUsage {
  const record = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const input = numberOrZero(record.input_tokens);
  const output = numberOrZero(record.output_tokens);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
