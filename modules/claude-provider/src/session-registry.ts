// Adapted from .work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs
import type { ClaudeBridgeEvent, ClaudeSession, PendingToolCallView } from "./claude-backend.js";
import type { ReplayableSseFrame } from "./types.js";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: Error): void;
};

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export type PendingToolCall = PendingToolCallView & {
  backendSession: ClaudeSession;
};

export type RequestLifecycleState =
  | "starting"
  | "emitted_call"
  | "waiting_tool_output"
  | "resolving"
  | "completed"
  | "failed";

export type RequestRun = {
  requestId: string;
  inputHash: string;
  state: RequestLifecycleState;
  transcript: ReplayableSseFrame[];
  terminal: Deferred<void>;
  terminalEmitted: boolean;
};

export type AdapterSession = {
  key: string;
  activeQuery?: ClaudeSession;
  activeIterator?: AsyncIterator<ClaudeBridgeEvent>;
  pendingByCallId: Map<string, PendingToolCall>;
  pendingQueue: PendingToolCall[];
  retiredCallIds: Set<string>;
  requestRuns: Map<string, RequestRun>;
  nextCallCounter: number;
  lastToolCatalogHash: string;
  lastSeenAt: number;
  textBuffer: string[];
};

export class SessionRegistry {
  private readonly sessions = new Map<string, AdapterSession>();

  getOrCreate(key: string): AdapterSession {
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const created: AdapterSession = {
      key,
      pendingByCallId: new Map(),
      pendingQueue: [],
      retiredCallIds: new Set(),
      requestRuns: new Map(),
      nextCallCounter: 0,
      lastToolCatalogHash: "",
      lastSeenAt: Date.now(),
      textBuffer: [],
    };
    this.sessions.set(key, created);
    return created;
  }

  get(key: string): AdapterSession | undefined {
    return this.sessions.get(key);
  }

  beginRun(session: AdapterSession, requestId: string, inputHash: string): { run: RequestRun; duplicate?: RequestRun } {
    // 실측(P1/P3): Codex는 한 turn loop의 모든 요청(첫 요청, function_call_output
    // 요청, 오류 재시도)에 같은 x-client-request-id를 쓴다. 재시도만 body가
    // 동일하므로 duplicate 판정은 requestId + inputHash 복합 키여야 한다.
    // requestId 단독 키면 tool output 요청을 재시도로 오판해 function_call
    // transcript를 replay하고 무한 tool 루프가 된다.
    const runKey = `${requestId}:${inputHash}`;
    const duplicate = session.requestRuns.get(runKey);
    if (duplicate) return { run: duplicate, duplicate };
    const run: RequestRun = {
      requestId,
      inputHash,
      state: "starting",
      transcript: [],
      terminal: deferred<void>(),
      terminalEmitted: false,
    };
    session.requestRuns.set(runKey, run);
    return { run };
  }

  registerPending(session: AdapterSession, call: PendingToolCallView, backendSession: ClaudeSession): PendingToolCall {
    const pending: PendingToolCall = { ...call, backendSession };
    if (session.retiredCallIds.has(call.codexCallId)) {
      throw new Error(`call_id was already retired: ${call.codexCallId}`);
    }
    session.pendingByCallId.set(call.codexCallId, pending);
    return pending;
  }

  resolvePending(session: AdapterSession, callId: string, output: string): PendingToolCall | undefined {
    const pending = session.pendingByCallId.get(callId);
    if (!pending) return undefined;
    session.pendingByCallId.delete(callId);
    session.retiredCallIds.add(callId);
    void pending.backendSession.resolveTool(callId, output);
    return pending;
  }

  queuePending(session: AdapterSession, call: PendingToolCall): void {
    session.pendingQueue.push(call);
  }

  drainQueuedPending(session: AdapterSession): PendingToolCall | undefined {
    return session.pendingQueue.shift();
  }

  retireExpired(now: number, ttlMs: number): PendingToolCall[] {
    const expired: PendingToolCall[] = [];
    for (const session of this.sessions.values()) {
      for (const [callId, pending] of session.pendingByCallId) {
        if (now - pending.createdAt <= ttlMs) continue;
        session.pendingByCallId.delete(callId);
        session.retiredCallIds.add(callId);
        expired.push(pending);
        void pending.backendSession.cancel("pending tool result expired");
      }
    }
    return expired;
  }

  sweepIdle(now: number, idleTtlMs: number): number {
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.pendingByCallId.size > 0) continue;
      if (now - session.lastSeenAt <= idleTtlMs) continue;
      void session.activeQuery?.close();
      this.sessions.delete(key);
      removed += 1;
    }
    return removed;
  }
}
