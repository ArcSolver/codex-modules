import type { IncomingMessage } from "node:http";

export function validateBindHost(host: string): asserts host is "127.0.0.1" | "::1" {
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`Refusing non-loopback bind host: ${host}`);
  }
}

export function assertAnthropicApiKeyAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ANTHROPIC_API_KEY && env.ALLOW_ANTHROPIC_API_KEY !== "1") {
    throw new Error("ANTHROPIC_API_KEY is present; set ALLOW_ANTHROPIC_API_KEY=1 if intentional.");
  }
}

export function buildScrubbedClaudeEnv(options: {
  allowAnthropicApiKey?: boolean;
  streamCloseTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Record<string, string | undefined> {
  const source = options.env ?? process.env;
  const keep = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  const out: Record<string, string | undefined> = {};
  for (const key of keep) out[key] = source[key];
  if (options.allowAnthropicApiKey) out.ANTHROPIC_API_KEY = source.ANTHROPIC_API_KEY;
  out.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = String(options.streamCloseTimeoutMs);
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "codex-modules-claude-provider/0.1.0";
  return out;
}

export function rejectBrowserOrigin(req: IncomingMessage): string | undefined {
  if (req.headers.origin) return "browser origin requests are not accepted";
  if (req.headers["sec-fetch-site"]) return "browser fetch metadata requests are not accepted";
  return undefined;
}

export function validateHostHeader(req: IncomingMessage, bindHost: string, port: number): string | undefined {
  const host = req.headers.host;
  if (!host) return "missing Host header";
  const expected = new Set([`${bindHost}:${port}`, bindHost]);
  if (bindHost === "127.0.0.1") {
    expected.add(`localhost:${port}`);
    expected.add("localhost");
  }
  if (!expected.has(host)) return `Host header does not match loopback listener`;
  return undefined;
}
