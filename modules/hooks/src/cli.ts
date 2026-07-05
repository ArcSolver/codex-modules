#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  apply,
  buildExecArgs,
  doctor,
  plan,
  remove,
  status,
  trust,
  validateHookSet,
  type HookSet,
} from "./index.js";

type Parsed = {
  command?: string;
  flags: Map<string, string[]>;
};

function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  let index = 0;
  const booleanFlags = new Set(["help", "json", "no-bypass-trust", "delete-created-file"]);
  while (index < rest.length) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    let value = "true";
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (!booleanFlags.has(name)) {
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
  return { command, flags };
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

function common(flags: Map<string, string[]>): { codexHome?: string; bin?: string | null; cwds?: string[] } {
  return {
    codexHome: one(flags, "codex-home"),
    bin: one(flags, "codex-bin"),
    cwds: many(flags, "cwd"),
  };
}

function requireHookSet(flags: Map<string, string[]>): HookSet {
  const path = one(flags, "hooks");
  if (!path) throw new Error("Missing required --hooks <hookset.json>");
  return validateHookSet(JSON.parse(readFileSync(path, "utf8")));
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printPlan(result: ReturnType<typeof plan>): void {
  console.log(`Codex home: ${result.codexHome}`);
  console.log(`hooks.json: ${result.hooksPath}`);
  console.log(`Summary: add=${result.summary.add} replace=${result.summary.replace} already=${result.summary.alreadyPresent}`);
  for (const change of result.changes) {
    const matcher = change.matcher === undefined ? "" : ` matcher=${change.matcher}`;
    console.log(`  ${change.action}: ${change.event}${matcher} ${change.command}`);
  }
}

function help(): string {
  return `Usage:
  codex-hooks plan --hooks hookset.json [--codex-home DIR] [--json]
  codex-hooks apply --hooks hookset.json [--codex-home DIR] [--json]
  codex-hooks trust [--codex-home DIR] [--json]
  codex-hooks remove [--codex-home DIR] [--delete-created-file] [--json]
  codex-hooks status [--codex-home DIR] [--json]
  codex-hooks doctor [--codex-home DIR] [--json]
  codex-hooks exec-args --hooks hookset.json [--no-bypass-trust] [--json]

Options:
  --hooks PATH       HookSet JSON using PascalCase Codex hook event names
  --codex-home DIR  Override CODEX_HOME
  --codex-bin PATH  Override codex binary for status/doctor/trust
  --cwd DIR         Add cwd for hooks/list discovery, repeatable
  --json            Print JSON output`;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed.command;
  const flags = parsed.flags;
  if (!command || has(flags, "help") || command === "--help" || command === "help") {
    console.log(help());
    return;
  }
  const json = has(flags, "json");

  if (command === "plan") {
    const result = plan(requireHookSet(flags), common(flags));
    if (json) printJson(result);
    else printPlan(result);
    return;
  }

  if (command === "apply") {
    const result = apply(requireHookSet(flags), common(flags));
    if (json) printJson(result);
    else {
      printPlan(result);
      console.log(`Backup: ${result.backup ?? "none"}`);
      console.log(`Manifest: ${result.manifestPath}`);
    }
    return;
  }

  if (command === "trust") {
    const result = await trust(common(flags));
    if (json) printJson(result);
    else {
      console.log(`Trusted ${result.trusted.length} hook(s).`);
      if (result.missing.length > 0) console.log(`Missing from discovery: ${result.missing.length}`);
      console.log(`Config: ${result.configPath}`);
    }
    return;
  }

  if (command === "remove") {
    const result = remove({ ...common(flags), deleteCreatedFile: has(flags, "delete-created-file") });
    if (json) printJson(result);
    else {
      console.log(`Removed ${result.removed.length} hook(s).`);
      console.log(`hooks.json backup: ${result.hooksBackup ?? "none"}`);
      console.log(`config.toml backup: ${result.configBackup ?? "none"}`);
    }
    return;
  }

  if (command === "status") {
    const result = await status(common(flags));
    if (json) printJson(result);
    else {
      console.log(`codex binary: ${result.codexBinary ?? "not found"}`);
      console.log(`version: ${result.version?.raw ?? "unknown"}`);
      console.log(`hooks discovered: ${result.hooks.length}`);
      if (result.appServerError) console.log(`hooks/list: ${result.appServerError}`);
      console.log(`session-flags: ${result.versionGate.sessionFlags} - ${result.versionGate.message}`);
    }
    return;
  }

  if (command === "doctor") {
    const result = await doctor(common(flags));
    if (json) printJson(result);
    else {
      console.log(result.ok ? "OK" : "WARN");
      console.log(`codex binary: ${result.codexBinary ?? "not found"}`);
      console.log(`version: ${result.version?.raw ?? "unknown"}`);
      console.log(`session-flags: ${result.versionGate.sessionFlags} - ${result.versionGate.message}`);
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "exec-args") {
    const result = buildExecArgs(requireHookSet(flags), { bypassTrust: !has(flags, "no-bypass-trust") });
    if (json) printJson(result);
    else console.log(result.map(shellQuote).join(" "));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
