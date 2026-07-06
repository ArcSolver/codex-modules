#!/usr/bin/env node
import {
  createJob,
  fillBlueprint,
  installTick,
  listBlueprints,
  listJobs,
  removeJob,
  removeTick,
  runJob,
  tick,
} from "./index.js";

type Parsed = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

const BOOLEAN_FLAGS = new Set([
  "all",
  "allow-codex",
  "delete-outputs",
  "dry-run",
  "execute",
  "help",
  "json",
  "load",
  "no-agent",
  "remove",
  "write",
]);

function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    let value = "true";
    if (inline !== undefined) {
      value = inline;
    } else if (!BOOLEAN_FLAGS.has(name)) {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${name}`);
      value = next;
      index++;
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
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

function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function help(): string {
  return `Usage:
  codex-scheduler create [--name TEXT] (--schedule TEXT --prompt TEXT | --blueprint KEY --slot name=value ...) [--cwd PATH] [--script PATH] [--no-agent] [--repeat N] [--store-dir PATH] [--json]
  codex-scheduler list [--store-dir PATH] [--all] [--json]
  codex-scheduler remove <id> [--store-dir PATH] [--delete-outputs] [--json]
  codex-scheduler run <id> [--store-dir PATH] [--dry-run|--execute] [--allow-codex] [--timeout SEC] [--stall SEC] [--json]
  codex-scheduler tick [--store-dir PATH] [--dry-run|--execute] [--allow-codex] [--limit N] [--now ISO] [--timeout SEC] [--stall SEC] [--json]
  codex-scheduler install-tick [--store-dir PATH] [--platform auto|darwin|linux] [--interval-min N] [--execute] [--allow-codex] [--write] [--load] [--remove] [--json]
  codex-scheduler blueprints [--json]`;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed.command;
  const flags = parsed.flags;
  if (!command || command === "help" || command === "--help" || has(flags, "help")) {
    console.log(help());
    return;
  }
  const json = has(flags, "json");
  const storeDir = one(flags, "store-dir");

  if (command === "create") {
    const blueprint = one(flags, "blueprint");
    const slots = parseSlots(many(flags, "slot"));
    const fromBlueprint = blueprint ? fillBlueprint(blueprint, slots) : null;
    const repeat = one(flags, "repeat");
    const scheduleInput = one(flags, "schedule") ?? fromBlueprint?.scheduleInput;
    if (!scheduleInput) throw new Error("Missing --schedule or --blueprint");
    const input = {
      ...(fromBlueprint ?? {}),
      name: one(flags, "name") ?? fromBlueprint?.name,
      scheduleInput,
      prompt: one(flags, "prompt") ?? fromBlueprint?.prompt,
      cwd: one(flags, "cwd") ?? fromBlueprint?.cwd,
      scriptPath: one(flags, "script") ?? fromBlueprint?.scriptPath,
      noAgent: has(flags, "no-agent") || fromBlueprint?.noAgent,
      repeat: repeat === undefined ? fromBlueprint?.repeat : Number(repeat),
    };
    const job = createJob(input, { storeDir });
    print(json ? job : `created ${job.id}`, json);
    return;
  }

  if (command === "list") {
    print(listJobs({ storeDir, all: has(flags, "all") }), json);
    return;
  }

  if (command === "remove") {
    const id = parsed.positionals[0];
    if (!id) throw new Error("Missing job id");
    print(removeJob(id, { storeDir, deleteOutputs: has(flags, "delete-outputs") }), json);
    return;
  }

  if (command === "run") {
    const id = parsed.positionals[0];
    if (!id) throw new Error("Missing job id");
    print(await runJob(id, runOptions(flags, storeDir)), json);
    return;
  }

  if (command === "tick") {
    const limit = one(flags, "limit");
    print(await tick({ ...runOptions(flags, storeDir), limit: limit === undefined ? undefined : Number(limit), now: one(flags, "now") }), json);
    return;
  }

  if (command === "install-tick") {
    const interval = one(flags, "interval-min");
    const opts = {
      storeDir,
      platform: one(flags, "platform") as "auto" | "darwin" | "linux" | undefined,
      intervalMin: interval === undefined ? undefined : Number(interval),
      execute: has(flags, "execute"),
      allowCodex: has(flags, "allow-codex"),
      write: has(flags, "write"),
      load: has(flags, "load"),
      remove: has(flags, "remove"),
      binPath: one(flags, "bin"),
    };
    print(opts.remove ? removeTick(opts) : installTick(opts), json);
    return;
  }

  if (command === "blueprints") {
    print(listBlueprints(), json);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function runOptions(flags: Map<string, string[]>, storeDir?: string) {
  const timeout = one(flags, "timeout");
  const stall = one(flags, "stall");
  return {
    storeDir,
    execute: has(flags, "execute") && !has(flags, "dry-run"),
    allowCodex: has(flags, "allow-codex"),
    timeoutSec: timeout === undefined ? undefined : Number(timeout),
    stallSec: stall === undefined ? undefined : Number(stall),
    bin: one(flags, "bin"),
  };
}

function parseSlots(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --slot, expected name=value: ${value}`);
    out[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return out;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
