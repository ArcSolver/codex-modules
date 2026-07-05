#!/usr/bin/env node

import {
  convertClaudeSkill,
  doctor,
  installSkill,
  listSkills,
  probe,
  removeSkill,
  rollback,
  type RootTarget,
} from "./index.js";

type Parsed = {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
};

const BOOLEAN_FLAGS = new Set(["force", "force-foreign", "help", "json"]);

function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
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
    let value = eq >= 0 ? arg.slice(eq + 1) : "true";
    if (eq < 0 && !BOOLEAN_FLAGS.has(name)) {
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

function target(flags: Map<string, string[]>): RootTarget {
  return one(flags, "target") ?? "user";
}

function common(flags: Map<string, string[]>): {
  home?: string;
  codexHome?: string;
  repoRoot?: string;
  target?: RootTarget;
} {
  return {
    home: one(flags, "home"),
    codexHome: one(flags, "codex-home"),
    repoRoot: one(flags, "repo-root"),
    target: one(flags, "target"),
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function help(): string {
  return `Usage:
  codex-skills install <dir> --target user|legacy|repo [--force]
  codex-skills list [--json]
  codex-skills remove <name> --target user|legacy|repo [--force-foreign]
  codex-skills convert <dir> [--json]
  codex-skills doctor [--json]
  codex-skills probe [--json]
  codex-skills rollback [--target user|legacy|repo]

Options:
  --home PATH        Override HOME for user skill root
  --codex-home PATH  Override CODEX_HOME for legacy skill root
  --repo-root PATH   Override repository root for repo skill root`;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const flags = parsed.flags;
  const json = has(flags, "json");
  const command = parsed.command;

  if (!command || command === "help" || command === "--help" || has(flags, "help")) {
    console.log(help());
    return;
  }

  if (command === "install") {
    const dir = parsed.positionals[0];
    if (!dir) throw new Error("install requires <dir>");
    const result = installSkill(dir, {
      ...common(flags),
      target: target(flags),
      force: has(flags, "force"),
    });
    if (json) printJson(result);
    else {
      console.log(`Installed ${result.name} to ${result.destDir}`);
      if (result.backupDir) console.log(`Backup: ${result.backupDir}`);
    }
    return;
  }

  if (command === "list") {
    const result = listSkills(common(flags));
    if (json) printJson(result);
    else {
      for (const key of ["user", "legacy", "repo"] as const) {
        console.log(`${key}:`);
        for (const skill of result[key]) console.log(`  ${skill.ok ? "OK" : "ERR"} ${skill.name ?? "(unknown)"} ${skill.dir}`);
      }
    }
    return;
  }

  if (command === "remove") {
    const name = parsed.positionals[0];
    if (!name) throw new Error("remove requires <name>");
    const result = removeSkill(name, {
      ...common(flags),
      target: target(flags),
      forceForeign: has(flags, "force-foreign"),
    });
    if (json) printJson(result);
    else {
      console.log(`Removed ${name} from ${result.destDir}`);
      console.log(`Backup: ${result.backupDir}`);
    }
    return;
  }

  if (command === "convert") {
    const dir = parsed.positionals[0];
    if (!dir) throw new Error("convert requires <dir>");
    const result = convertClaudeSkill(dir);
    if (json) printJson(result);
    else {
      console.log(result.ok ? `OK ${result.name}` : "Invalid skill");
      for (const warning of result.warnings) console.log(`WARN ${warning}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "probe") {
    const result = probe(common(flags));
    if (json) printJson(result);
    else if (result.skipped) console.log(`SKIP ${result.reason}`);
    else {
      console.log(`codex: ${result.codexVersion?.raw ?? result.codexBinary}`);
      for (const skill of result.skills) console.log(`${skill.present ? "OK" : "MISS"} ${skill.name}`);
    }
    if (!result.skipped && !result.ok) process.exitCode = 1;
    return;
  }

  if (command === "doctor") {
    const result = doctor(common(flags));
    if (json) printJson(result);
    else {
      for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "rollback") {
    const result = rollback(common(flags));
    if (json) printJson(result);
    else if (result.missing) console.log("No rollback entry found.");
    else {
      console.log(result.ok ? `Rolled back ${result.action} for ${result.name}.` : `Rollback failed for ${result.name}.`);
      for (const warning of result.warnings) console.log(`WARN ${warning}`);
    }
    if (!result.ok && !result.missing) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command "${command}"`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
