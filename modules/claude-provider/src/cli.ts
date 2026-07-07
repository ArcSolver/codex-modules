#!/usr/bin/env node
import { createAdapterServer } from "./server.js";
import { doctor } from "./doctor.js";
import { installProvider, uninstallProvider } from "./install.js";
import { createStderrLogger as loggerFactory } from "./logging.js";
import { DEFAULT_HOST, DEFAULT_MODEL, DEFAULT_PORT, DEFAULT_PROVIDER_ID, type LogLevel } from "./types.js";

type Parsed = {
  command?: string;
  flags: Record<string, string | boolean>;
};

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  const json = Boolean(parsed.flags.json);
  try {
    switch (parsed.command) {
      case "serve":
        return await serve(parsed);
      case "install":
        return await printResult(json, await installProvider({
          codexHome: stringFlag(parsed, "codex-home"),
          baseUrl: stringFlag(parsed, "base-url"),
          providerId: stringFlag(parsed, "provider-id") ?? DEFAULT_PROVIDER_ID,
          model: stringFlag(parsed, "model") ?? DEFAULT_MODEL,
          setDefault: Boolean(parsed.flags["set-default"]),
        }));
      case "uninstall":
        return await printResult(json, await uninstallProvider({
          codexHome: stringFlag(parsed, "codex-home"),
          providerId: stringFlag(parsed, "provider-id") ?? DEFAULT_PROVIDER_ID,
          restoreBackup: stringFlag(parsed, "restore-backup"),
        }));
      case "doctor": {
        const report = await doctor({ codexHome: stringFlag(parsed, "codex-home"), baseUrl: stringFlag(parsed, "base-url") });
        if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
        else {
          for (const check of report.checks) process.stderr.write(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}\n`);
        }
        return report.ok ? 0 : 1;
      }
      case "help":
      case undefined:
        usage();
        return parsed.command ? 0 : 1;
      default:
        process.stderr.write(`Unknown command: ${parsed.command}\n`);
        usage();
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}

async function serve(parsed: Parsed): Promise<number> {
  const host = stringFlag(parsed, "host") ?? DEFAULT_HOST;
  const port = numberFlag(parsed, "port") ?? DEFAULT_PORT;
  const logLevel = (stringFlag(parsed, "log-level") ?? "info") as LogLevel;
  const server = await createAdapterServer({
    host: host as "127.0.0.1" | "::1",
    port,
    model: stringFlag(parsed, "model") ?? DEFAULT_MODEL,
    logger: loggerFactory(logLevel, Boolean(parsed.flags["unsafe-log-previews"])),
    unsafeLogPreviews: Boolean(parsed.flags["unsafe-log-previews"]),
    forwardPartialText: Boolean(parsed.flags["forward-partial-text"]),
    timeouts: {
      idleTtlMs: numberFlag(parsed, "idle-ttl-ms"),
      firstOutputMs: numberFlag(parsed, "request-timeout-ms"),
      postToolMs: numberFlag(parsed, "request-timeout-ms"),
      toolResultTtlMs: numberFlag(parsed, "tool-result-ttl-ms"),
    },
  });
  const payload = { baseUrl: server.baseUrl, providerId: DEFAULT_PROVIDER_ID };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise(() => undefined);
  return 0;
}

async function printResult(json: boolean, result: unknown): Promise<number> {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  return isRecord(result) && result.ok === false ? 1 : 0;
}

function parse(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(parsed: Parsed, name: string): number | undefined {
  const value = stringFlag(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) throw new Error(`--${name} must be a number`);
  return parsedValue;
}

function usage(): void {
  process.stderr.write(`codex-claude-provider <command>

Commands:
  serve [--host 127.0.0.1] [--port 47777] [--model claude-provider]
  install --codex-home <path> [--base-url http://127.0.0.1:47777/v1] [--set-default]
  uninstall --codex-home <path> [--restore-backup <path>]
  doctor [--codex-home <path>] [--base-url http://127.0.0.1:47777/v1] [--json]
`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
