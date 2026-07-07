import { installTeam, uninstallTeam } from "./agents.js";
import { doctor, doctorIsHealthy, formatDoctor } from "./doctor.js";
import { assembleLeaderPrompt } from "./prompt.js";
import { runTeam } from "./runner.js";
import { installSkill, uninstallSkill } from "./skill.js";
import {
  addNote,
  addTask,
  bindMember,
  claimTask,
  completeTask,
  finishState,
  initState,
  listNotes,
  listTasks,
  showState,
} from "./state.js";
import { collectTeamErrors, parseTeamJson, writePreset } from "./team.js";

type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | true>;
};

type FlagKind = "value" | "boolean";
type FlagSpec = Readonly<Record<string, FlagKind>>;

const FLAG_SPECS = {
  init: { preset: "value", out: "value" },
  validate: {},
  doctor: { "codex-home": "value", "state-dir": "value", json: "boolean" },
  install: { "codex-home": "value", scope: "value", force: "boolean", "skip-model-check": "boolean" },
  uninstall: { "codex-home": "value", scope: "value" },
  "leader-prompt": { goal: "value" },
  "skill install": { "codex-home": "value", force: "boolean" },
  "skill uninstall": { "codex-home": "value" },
  run: {
    goal: "value",
    "codex-home": "value",
    "state-dir": "value",
    sandbox: "value",
    "timeout-sec": "value",
    "stall-sec": "value",
    execute: "boolean",
    "allow-codex": "boolean",
  },
  "state init": { "state-dir": "value", goal: "value", "no-gitignore": "boolean" },
  "state show": { "state-dir": "value", json: "boolean" },
  "state finish": { "state-dir": "value", status: "value" },
  "member bind": { "agent-id": "value", "state-dir": "value", nickname: "value" },
  "task add": { "state-dir": "value", title: "value", detail: "value", "depends-on": "value" },
  "task claim": { "state-dir": "value", actor: "value", "lease-sec": "value" },
  "task complete": { "state-dir": "value", actor: "value", result: "value" },
  "task fail": { "state-dir": "value", actor: "value", result: "value" },
  "task list": { "state-dir": "value", reclaim: "boolean", json: "boolean" },
  "note add": { "state-dir": "value", actor: "value", text: "value", kind: "value" },
  "note list": { "state-dir": "value", json: "boolean" },
} as const satisfies Record<string, FlagSpec>;

export async function main(args: string[]): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    const parsed = parseArgs(rest, "init");
    const preset = flag(parsed, "preset") ?? "review-panel";
    if (preset !== "review-panel" && preset !== "swarm" && preset !== "pipeline") throw new Error("--preset must be review-panel, swarm, or pipeline");
    writePreset(flag(parsed, "out") ?? "team.json", preset);
    console.log("OK init");
    return;
  }

  if (command === "validate") {
    const parsed = parseArgs(rest, "validate");
    const file = parsed.positional[0];
    if (!file) throw new Error("usage: codex-teams validate <team.json>");
    const raw = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(file, "utf8"))) as unknown;
    const errors = collectTeamErrors(raw);
    if (errors.length > 0) throw new Error(`${file} is invalid:\n- ${errors.join("\n- ")}`);
    console.log("OK validate");
    return;
  }

  if (command === "doctor") {
    const parsed = parseArgs(rest, "doctor");
    const report = doctor({ codexHome: flag(parsed, "codex-home"), stateDir: flag(parsed, "state-dir") });
    if (boolFlag(parsed, "json")) console.log(JSON.stringify(report, null, 2));
    else process.stdout.write(formatDoctor(report));
    if (!doctorIsHealthy(report)) process.exitCode = 1;
    return;
  }

  if (command === "install") {
    const parsed = parseArgs(rest, "install");
    const file = parsed.positional[0];
    if (!file) throw new Error("usage: codex-teams install <team.json>");
    const result = installTeam(file, {
      codexHome: flag(parsed, "codex-home"),
      scope: scopeFlag(parsed),
      force: boolFlag(parsed, "force"),
      skipModelCheck: boolFlag(parsed, "skip-model-check"),
    });
    for (const warning of result.warnings) console.error(`WARN ${warning}`);
    console.log(`OK install ${result.team} ${result.files.length} file(s)`);
    return;
  }

  if (command === "uninstall") {
    const parsed = parseArgs(rest, "uninstall");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams uninstall <team-name>");
    const result = uninstallTeam(team, { codexHome: flag(parsed, "codex-home"), scope: scopeFlag(parsed) });
    for (const warning of result.warnings) console.error(`WARN ${warning}`);
    console.log(`OK uninstall ${result.team} removed=${result.removed.length} restored=${result.restored.length}`);
    return;
  }

  if (command === "leader-prompt") {
    const parsed = parseArgs(rest, "leader-prompt");
    const file = parsed.positional[0];
    const goal = requiredFlag(parsed, "goal");
    if (!file) throw new Error("usage: codex-teams leader-prompt <team.json> --goal <text>");
    process.stdout.write(assembleLeaderPrompt(parseTeamJson(file), goal));
    return;
  }

  if (command === "skill") {
    const [subcommand, ...skillRest] = rest;
    if (subcommand === "install") {
      const parsed = parseArgs(skillRest, "skill install");
      const result = installSkill({ codexHome: flag(parsed, "codex-home"), force: boolFlag(parsed, "force") });
      console.log(`OK skill install ${result.file}`);
      return;
    }
    if (subcommand === "uninstall") {
      const parsed = parseArgs(skillRest, "skill uninstall");
      const result = uninstallSkill({ codexHome: flag(parsed, "codex-home") });
      console.log(`OK skill uninstall removed=${result.removed.length} restored=${result.restored.length}`);
      return;
    }
    throw new Error("usage: codex-teams skill install|uninstall");
  }

  if (command === "run") {
    const parsed = parseArgs(rest, "run", { sandboxAlias: true });
    const file = parsed.positional[0];
    if (!file) throw new Error("usage: codex-teams run <team.json> --goal <text>");
    const result = await runTeam(file, {
      goal: requiredFlag(parsed, "goal"),
      codexHome: flag(parsed, "codex-home"),
      stateDir: flag(parsed, "state-dir"),
      sandbox: sandboxFlag(parsed),
      timeoutSec: numberFlag(parsed, "timeout-sec"),
      stallSec: numberFlag(parsed, "stall-sec"),
      execute: boolFlag(parsed, "execute"),
      allowCodex: boolFlag(parsed, "allow-codex"),
    });
    if (result.mode === "dry-run") {
      console.log("DRY-RUN codex argv:");
      console.log(result.argv.map(shellQuote).join(" "));
      console.log("DRY-RUN leader prompt:");
      process.stdout.write(result.prompt);
    } else {
      console.log(`OK run ${result.status} exit=${result.exitCode ?? "null"} runDir=${result.runDir}`);
    }
    return;
  }

  if (command === "state") {
    handleState(rest);
    return;
  }

  if (command === "member") {
    handleMember(rest);
    return;
  }

  if (command === "task") {
    handleTask(rest);
    return;
  }

  if (command === "note") {
    handleNote(rest);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function handleState(args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "init") {
    const parsed = parseArgs(rest, "state init");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams state init|show|finish <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const result = initState(team, requiredFlag(parsed, "goal"), { ...opts, noGitignore: boolFlag(parsed, "no-gitignore") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "show") {
    const parsed = parseArgs(rest, "state show");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams state init|show|finish <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const result = showState(team, opts);
    if (boolFlag(parsed, "json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`team=${result.team} status=${result.status} goal=${result.goal}`);
    return;
  }
  if (subcommand === "finish") {
    const parsed = parseArgs(rest, "state finish");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams state init|show|finish <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const status = requiredFlag(parsed, "status");
    if (status !== "ok" && status !== "partial") throw new Error("--status must be ok or partial");
    console.log(JSON.stringify(finishState(team, status, opts), null, 2));
    return;
  }
  throw new Error("usage: codex-teams state init|show|finish <team>");
}

function handleMember(args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand !== "bind") throw new Error("usage: codex-teams member bind <team> <member> --agent-id <id>");
  const parsed = parseArgs(rest, "member bind");
  const [team, member] = parsed.positional;
  if (!team || !member) throw new Error("usage: codex-teams member bind <team> <member> --agent-id <id>");
  console.log(JSON.stringify(bindMember(team, member, requiredFlag(parsed, "agent-id"), { stateDir: flag(parsed, "state-dir"), nickname: flag(parsed, "nickname") }), null, 2));
}

function handleTask(args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const parsed = parseArgs(rest, "task add");
    const [team] = parsed.positional;
    if (!team) throw new Error("usage: codex-teams task add|claim|complete|fail|list <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const task = addTask(team, { title: requiredFlag(parsed, "title"), detail: flag(parsed, "detail"), dependsOn: splitCsv(flag(parsed, "depends-on")) }, opts);
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (subcommand === "claim") {
    const parsed = parseArgs(rest, "task claim");
    const [team, taskId] = parsed.positional;
    if (!team) throw new Error("usage: codex-teams task add|claim|complete|fail|list <team>");
    if (!taskId) throw new Error("usage: codex-teams task claim <team> <task-id> --actor <name>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    console.log(JSON.stringify(claimTask(team, taskId, { actor: requiredFlag(parsed, "actor"), leaseSec: numberFlag(parsed, "lease-sec") }, opts), null, 2));
    return;
  }
  if (subcommand === "complete" || subcommand === "fail") {
    const parsed = parseArgs(rest, subcommand === "complete" ? "task complete" : "task fail");
    const [team, taskId] = parsed.positional;
    if (!team) throw new Error("usage: codex-teams task add|claim|complete|fail|list <team>");
    if (!taskId) throw new Error(`usage: codex-teams task ${subcommand} <team> <task-id> --actor <name>`);
    const opts = { stateDir: flag(parsed, "state-dir") };
    console.log(JSON.stringify(completeTask(team, taskId, { actor: requiredFlag(parsed, "actor"), result: flag(parsed, "result"), failed: subcommand === "fail" }, opts), null, 2));
    return;
  }
  if (subcommand === "list") {
    const parsed = parseArgs(rest, "task list");
    const [team] = parsed.positional;
    if (!team) throw new Error("usage: codex-teams task add|claim|complete|fail|list <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const tasks = listTasks(team, { ...opts, reclaim: boolFlag(parsed, "reclaim") });
    if (boolFlag(parsed, "json")) console.log(JSON.stringify(tasks, null, 2));
    else for (const task of tasks.tasks) console.log(`${task.id}\t${task.status}\t${task.title}`);
    return;
  }
  throw new Error("usage: codex-teams task add|claim|complete|fail|list <team>");
}

function handleNote(args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") {
    const parsed = parseArgs(rest, "note add");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams note add|list <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    console.log(JSON.stringify(addNote(team, { actor: requiredFlag(parsed, "actor"), text: requiredFlag(parsed, "text"), kind: kindFlag(parsed) }, opts), null, 2));
    return;
  }
  if (subcommand === "list") {
    const parsed = parseArgs(rest, "note list");
    const team = parsed.positional[0];
    if (!team) throw new Error("usage: codex-teams note add|list <team>");
    const opts = { stateDir: flag(parsed, "state-dir") };
    const notes = listNotes(team, opts);
    if (boolFlag(parsed, "json")) console.log(JSON.stringify(notes, null, 2));
    else for (const note of notes) console.log(`${note.ts}\t${note.actor}\t${note.kind}\t${note.text}`);
    return;
  }
  throw new Error("usage: codex-teams note add|list <team>");
}

function parseArgs(args: string[], commandPath: keyof typeof FLAG_SPECS, options: { sandboxAlias?: boolean } = {}): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const spec: FlagSpec = FLAG_SPECS[commandPath];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const name = arg.slice(2, eq);
        if (!isKnownFlag(spec, name)) throw new Error(`unknown flag --${name} for '${commandPath}'`);
        flags.set(name, arg.slice(eq + 1));
        continue;
      }
      const name = arg.slice(2);
      if (!isKnownFlag(spec, name)) throw new Error(`unknown flag --${name} for '${commandPath}'`);
      const next = args[i + 1];
      if (spec[name] === "value") {
        if (next === undefined) throw new Error(`--${name} requires a value`);
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (arg === "-s") {
      if (!options.sandboxAlias || spec.sandbox !== "value") throw new Error(`unknown flag -s for '${commandPath}'`);
      const next = args[++i];
      if (!next) throw new Error("-s requires a value");
      flags.set("sandbox", next);
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function isKnownFlag(spec: FlagSpec, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(spec, name);
}

function flag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined || value === true) return undefined;
  return value;
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = flag(parsed, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true || parsed.flags.get(name) === "true";
}

function numberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = flag(parsed, name);
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) throw new Error(`--${name} must be a number`);
  return parsedValue;
}

function scopeFlag(parsed: ParsedArgs): "user" | "project" {
  const value = flag(parsed, "scope") ?? "user";
  if (value !== "user" && value !== "project") throw new Error("--scope must be user or project");
  return value;
}

function sandboxFlag(parsed: ParsedArgs): "read-only" | "workspace-write" | undefined {
  const value = flag(parsed, "sandbox");
  if (value === undefined) return undefined;
  if (value !== "read-only" && value !== "workspace-write") throw new Error("-s/--sandbox must be read-only or workspace-write");
  return value;
}

function kindFlag(parsed: ParsedArgs): "note" | "handoff" | "decision" | undefined {
  const value = flag(parsed, "kind");
  if (value === undefined) return undefined;
  if (value !== "note" && value !== "handoff" && value !== "decision") throw new Error("--kind must be note, handoff, or decision");
  return value;
}

function splitCsv(value: string | undefined): string[] | undefined {
  return value ? value.split(",").map(item => item.trim()).filter(Boolean) : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp(): void {
  console.log(`codex-teams

Usage:
  codex-teams init [--preset review-panel|swarm|pipeline] [--out team.json]
  codex-teams validate <team.json>
  codex-teams doctor [--codex-home <dir>] [--state-dir <dir>] [--json]
  codex-teams install <team.json> [--codex-home <dir>] [--scope user|project] [--force] [--skip-model-check]
  codex-teams uninstall <team-name> [--codex-home <dir>] [--scope user|project]
  codex-teams leader-prompt <team.json> --goal <text>
  codex-teams skill install [--codex-home <dir>] [--force]
  codex-teams skill uninstall [--codex-home <dir>]
  codex-teams run <team.json> --goal <text> [--codex-home <dir>] [--state-dir <dir>] [--execute --allow-codex] [-s workspace-write] [--timeout-sec N] [--stall-sec N]
  codex-teams state init|show|finish <team>
  codex-teams member bind <team> <member> --agent-id <id>
  codex-teams task add|claim|complete|fail|list <team>
  codex-teams note add|list <team>`);
}
