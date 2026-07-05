#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  addServer,
  doctor,
  getServer,
  listServers,
  patchServer,
  plan,
  removeServer,
  rollback,
  type PatchKeys,
  type ServerDef,
} from "./index.js";

type Parsed = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

const BOOLEAN_FLAGS = new Set(["force", "help", "json"]);

function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      index++;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    let value = "true";
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (!BOOLEAN_FLAGS.has(name)) {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${name}`);
      value = next;
      index++;
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
    index++;
  }
  return { command, positionals, flags };
}

function has(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

function many(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

function common(flags: Map<string, string[]>): { codexHome?: string } {
  return { codexHome: one(flags, "codex-home") };
}

function parseKeyValue(raw: string, flag: string): [string, string] {
  const split = raw.indexOf("=");
  if (split <= 0) throw new Error(`${flag} must look like KEY=VALUE, got "${raw}"`);
  return [raw.slice(0, split), raw.slice(split + 1)];
}

function parseRecord(values: string[], flag: string): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const [key, child] = parseKeyValue(value, flag);
    out[key] = child;
  }
  return out;
}

function parseValue(raw: string): string | number | boolean | string[] {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("\"")) return JSON.parse(trimmed) as string | string[];
  return raw;
}

function parsePatch(flags: Map<string, string[]>): PatchKeys {
  const out: PatchKeys = {};
  const from = one(flags, "from");
  if (from) Object.assign(out, JSON.parse(readFileSync(from, "utf8")) as PatchKeys);
  for (const value of many(flags, "set")) {
    const [key, child] = parseKeyValue(value, "--set");
    out[key] = parseValue(child);
  }
  if (Object.keys(out).length === 0) throw new Error("patch requires --set KEY=VALUE or --from patch.json");
  return out;
}

function parseDef(flags: Map<string, string[]>): ServerDef {
  const from = one(flags, "from");
  if (from) return JSON.parse(readFileSync(from, "utf8")) as ServerDef;
  const name = one(flags, "name");
  if (!name) throw new Error("add/plan requires --name or --from def.json");
  const url = one(flags, "url");
  if (url) {
    return {
      name,
      url,
      bearerTokenEnvVar: one(flags, "bearer-token-env-var"),
      httpHeaders: parseRecord(many(flags, "http-header"), "--http-header"),
    };
  }
  const command = one(flags, "command");
  if (!command) throw new Error("stdio add/plan requires --command or --url");
  return {
    name,
    command,
    args: many(flags, "arg"),
    env: parseRecord(many(flags, "env"), "--env"),
    envVars: many(flags, "env-var"),
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): string {
  return `codex-mcp-manager

Usage:
  codex-mcp-manager add --name NAME (--command CMD [--arg ARG] | --url URL) [options]
  codex-mcp-manager add --from def.json [--force] [--codex-home DIR]
  codex-mcp-manager plan --name NAME (--command CMD | --url URL) [--json]
  codex-mcp-manager list [--json] [--codex-home DIR]
  codex-mcp-manager get NAME [--json] [--codex-home DIR]
  codex-mcp-manager patch NAME --set KEY=VALUE [--set KEY=VALUE] [--json]
  codex-mcp-manager remove NAME [--json] [--codex-home DIR]
  codex-mcp-manager rollback [--json] [--codex-home DIR]
  codex-mcp-manager doctor [--json] [--codex-home DIR]

Options:
  --force                         Replace an existing server on add
  --codex-home DIR                Override CODEX_HOME for child codex commands
  --from FILE                     Read add definition or patch keys from JSON
  --env KEY=VALUE                 stdio environment variable, repeatable
  --env-var NAME                  stdio env_vars passthrough name, repeatable
  --http-header KEY=VALUE         HTTP http_headers entry, repeatable
  --bearer-token-env-var NAME     HTTP bearer token environment variable
  --set KEY=VALUE                 Patch advanced MCP key; VALUE may be JSON`;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const flags = parsed.flags;
  const command = parsed.command;
  if (!command || command === "help" || command === "--help" || has(flags, "help")) {
    console.log(help());
    return;
  }

  const json = has(flags, "json");
  if (command === "list") {
    const result = await listServers(common(flags));
    if (json) printJson(result);
    else for (const server of result) console.log(String((server as Record<string, unknown>).name ?? JSON.stringify(server)));
    return;
  }
  if (command === "get") {
    const name = parsed.positionals[0] ?? one(flags, "name");
    if (!name) throw new Error("get requires a server name");
    const result = await getServer(name, common(flags));
    if (json) printJson(result);
    else console.log(result ? JSON.stringify(result, null, 2) : "not found");
    if (!result) process.exitCode = 1;
    return;
  }
  if (command === "plan") {
    const result = await plan(parseDef(flags), common(flags));
    if (json) printJson(result);
    else {
      console.log(`${result.serverName}: ${result.status}`);
      for (const change of result.changes) console.log(`  ${change}`);
      for (const conflict of result.conflicts) console.log(`CONFLICT ${conflict}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "add") {
    const result = await addServer(parseDef(flags), { ...common(flags), force: has(flags, "force") });
    if (json) printJson(result);
    else {
      console.log(`Added ${result.serverName}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      console.log(`Manifest: ${result.manifestPath}`);
    }
    return;
  }
  if (command === "patch") {
    const name = parsed.positionals[0] ?? one(flags, "name");
    if (!name) throw new Error("patch requires a server name");
    const result = await patchServer(name, parsePatch(flags), common(flags));
    if (json) printJson(result);
    else {
      console.log(`Patched ${result.serverName}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
    }
    return;
  }
  if (command === "remove") {
    const name = parsed.positionals[0] ?? one(flags, "name");
    if (!name) throw new Error("remove requires a server name");
    const result = await removeServer(name, common(flags));
    if (json) printJson(result);
    else {
      console.log(`Removed ${result.serverName}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
    }
    return;
  }
  if (command === "rollback") {
    const result = await rollback(common(flags));
    if (json) printJson(result);
    else console.log(result.ok ? `Rolled back ${result.configPath}` : "No rollback backup found.");
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "doctor") {
    const result = await doctor(common(flags));
    if (json) printJson(result);
    else for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command "${command}"`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
