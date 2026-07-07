// Adapted from .work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs
import { createHash } from "node:crypto";
import type { AdapterLogger, LogLevel } from "./types.js";

const SECRET_KEY_RE = /(authorization|api-key|token|cookie|secret|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)/i;
const HIGH_ENTROPY_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

export function safe(value: unknown): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => {
      if (SECRET_KEY_RE.test(key)) return "[REDACTED]";
      if (typeof inner === "bigint") return inner.toString();
      if (inner && typeof inner === "object") {
        if (seen.has(inner)) return "[Circular]";
        seen.add(inner);
      }
      if (typeof inner === "function") {
        const named = inner as { name?: string };
        return `[Function ${named.name || "anonymous"}]`;
      }
      if (typeof inner === "string") return redactString(inner);
      return inner;
    }),
  );
}

export function redactString(value: string): string {
  return value.replace(HIGH_ENTROPY_RE, "[REDACTED]");
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string): string {
  return hashString(value).slice(0, 12);
}

export function preview(value: unknown, enabled: boolean, max = 600): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(safe(value));
  const summary = { length: text.length, sha256: hashString(text) };
  if (!enabled) return summary;
  return {
    ...summary,
    preview: redactString(text).split(/\r?\n/).slice(0, 12).join("\n").slice(0, max),
  };
}

export function createStderrLogger(level: LogLevel = "info", unsafeLogPreviews = false): AdapterLogger {
  const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30 };
  const should = (candidate: LogLevel) => rank[candidate] >= rank[level];
  const write = (candidate: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    if (!should(candidate)) return;
    const payload = safe({ at: new Date().toISOString(), level: candidate, event, ...fields, unsafeLogPreviews });
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
  };
}
