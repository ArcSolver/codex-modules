#!/usr/bin/env node
import { parseArgs } from "node:util";
import { sync } from "./sync/sync.js";
import { search } from "./search/query.js";
import { around, read } from "./search/views.js";
import { formatAroundResult, formatReadResult, formatSearchResult, formatSyncResult } from "./output/human.js";
import type { MessageRole, SearchSort } from "./types.js";

type CliResult = { code: number; stdout?: string; stderr?: string };

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const result = await run(argv);
  if (result.stdout) {
    process.stdout.write(`${result.stdout}\n`);
  }
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
  return result.code;
}

async function run(argv: string[]): Promise<CliResult> {
  const command = argv[0];
  const rest = argv.slice(1);
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      return { code: 0, stdout: usage() };
    }
    if (command === "sync") {
      return await runSync(rest);
    }
    if (command === "search") {
      return await runSearch(rest);
    }
    if (command === "read") {
      return await runRead(rest);
    }
    if (command === "around") {
      return await runAround(rest);
    }
    return { code: 2, stderr: `Unknown command: ${command}\n\n${usage()}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wantsJson = argv.includes("--json");
    if (wantsJson) {
      return {
        code: 1,
        stdout: JSON.stringify({ success: false, error: { message, code: "runtime_error" } }, null, 2),
      };
    }
    return { code: 1, stderr: message };
  }
}

async function runSync(argv: string[]): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: false,
    options: commonOptions({
      since: { type: "string" },
      until: { type: "string" },
      cwd: { type: "string" },
      "session-id": { type: "string" },
      path: { type: "string" },
      "include-archived": { type: "boolean" },
      "exclude-subagents": { type: "boolean" },
      rebuild: { type: "boolean" },
      "dry-run": { type: "boolean" },
    }),
  });
  const result = await sync({
    codexHome: stringOpt(parsed.values["codex-home"]),
    stateDir: stringOpt(parsed.values["state-dir"]),
    since: stringOpt(parsed.values.since),
    until: stringOpt(parsed.values.until),
    cwdPrefix: stringOpt(parsed.values.cwd),
    sessionId: stringOpt(parsed.values["session-id"]),
    path: stringOpt(parsed.values.path),
    includeArchived: boolOpt(parsed.values["include-archived"]),
    excludeSubagents: boolOpt(parsed.values["exclude-subagents"]),
    rebuild: boolOpt(parsed.values.rebuild),
    dryRun: boolOpt(parsed.values["dry-run"]),
    debugPaths: boolOpt(parsed.values["debug-paths"]),
  });
  return output(result.success ? 0 : 1, result, formatSyncResult(result), parsed.values.json === true);
}

async function runSearch(argv: string[]): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: commonOptions({
      limit: { type: "string" },
      "scan-limit": { type: "string" },
      sort: { type: "string" },
      window: { type: "string" },
      bookend: { type: "string" },
      role: { type: "string" },
      cwd: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      "exclude-subagents": { type: "boolean" },
    }),
  });
  const query = parsed.positionals.join(" ").trim();
  if (!query) {
    return { code: 2, stderr: "search requires a query" };
  }
  const result = await search({
    query,
    stateDir: stringOpt(parsed.values["state-dir"]),
    limit: numberOpt(parsed.values.limit),
    scanLimit: numberOpt(parsed.values["scan-limit"]),
    sort: sortOpt(parsed.values.sort),
    window: numberOpt(parsed.values.window),
    bookend: numberOpt(parsed.values.bookend),
    roles: roleOpt(parsed.values.role),
    cwdPrefix: stringOpt(parsed.values.cwd),
    since: stringOpt(parsed.values.since),
    until: stringOpt(parsed.values.until),
    excludeSubagents: boolOpt(parsed.values["exclude-subagents"]),
    debugPaths: boolOpt(parsed.values["debug-paths"]),
  });
  return output(0, result, formatSearchResult(result), parsed.values.json === true);
}

async function runRead(argv: string[]): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: commonOptions({
      head: { type: "string" },
      tail: { type: "string" },
      full: { type: "boolean" },
    }),
  });
  const sessionId = parsed.positionals[0];
  if (!sessionId) {
    return { code: 2, stderr: "read requires a session-id" };
  }
  const result = await read({
    sessionId,
    stateDir: stringOpt(parsed.values["state-dir"]),
    head: numberOpt(parsed.values.head),
    tail: numberOpt(parsed.values.tail),
    full: boolOpt(parsed.values.full),
    debugPaths: boolOpt(parsed.values["debug-paths"]),
  });
  return output(0, result, formatReadResult(result), parsed.values.json === true);
}

async function runAround(argv: string[]): Promise<CliResult> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: commonOptions({
      window: { type: "string" },
    }),
  });
  const [sessionId, msgRef] = parsed.positionals;
  if (!sessionId || !msgRef) {
    return { code: 2, stderr: "around requires a session-id and msg-ref" };
  }
  const result = await around({
    sessionId,
    msgRef,
    stateDir: stringOpt(parsed.values["state-dir"]),
    window: numberOpt(parsed.values.window),
    debugPaths: boolOpt(parsed.values["debug-paths"]),
  });
  return output(0, result, formatAroundResult(result), parsed.values.json === true);
}

function commonOptions(extra: Record<string, { type: "string" | "boolean" }>): Record<string, { type: "string" | "boolean" }> {
  return {
    "codex-home": { type: "string" },
    "state-dir": { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    "debug-paths": { type: "boolean" },
    ...extra,
  };
}

function output(code: number, jsonValue: unknown, human: string, json: boolean): CliResult {
  return { code, stdout: json ? JSON.stringify(jsonValue, null, 2) : human };
}

function stringOpt(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolOpt(value: unknown): boolean | undefined {
  return value === true ? true : undefined;
}

function numberOpt(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sortOpt(value: unknown): SearchSort | undefined {
  if (value === "relevance" || value === "newest" || value === "oldest") {
    return value;
  }
  return undefined;
}

function roleOpt(value: unknown): MessageRole[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const roles = value
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is MessageRole => role === "user" || role === "assistant" || role === "tool" || role === "function" || role === "system");
  return roles.length > 0 ? roles : undefined;
}

function usage(): string {
  return `codex-session-recall

Commands:
  sync      Index Codex rollout JSONL into local SQLite state
  search    Search indexed sessions
  read      Read a session by id
  around    Show messages around a session-local message ref

Run a command with --json for machine-readable output.`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
