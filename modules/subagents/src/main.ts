import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor } from "./native.js";
import { runTasks } from "./runner.js";
import type { RunTasksOptions, TaskSpec } from "./types.js";

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

  if (command === "doctor") {
    const json = rest.includes("--json");
    const result = doctor();
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`codex binary: ${result.codexBinary ?? "not found"}`);
    console.log(`version: ${result.version ?? "unknown"}`);
    if (result.native.error) console.log(`native features: unavailable (${result.native.error})`);
    for (const feature of result.native.features) {
      console.log(`${feature.name}: ${feature.stage ?? "missing"} enabled=${feature.enabled} usable=${feature.usable}`);
    }
    console.log("recommendations:");
    for (const item of result.recommendations) console.log(`- ${item}`);
    return;
  }

  if (command === "run") {
    const parsed = parseRunArgs(rest);
    mkdirSync(parsed.outDir, { recursive: true });
    const tasks = readTasks(parsed.tasksPath);
    const results = await runTasks(tasks, parsed.options);
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every(result => result.status === "ok") ? 0 : 1;
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseRunArgs(args: string[]): { tasksPath: string; outDir: string; options: RunTasksOptions } {
  let tasksPath: string | null = null;
  let outDir: string | null = null;
  const options: Partial<RunTasksOptions> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--tasks") tasksPath = requireValue(args, ++i, "--tasks");
    else if (arg === "--out") outDir = requireValue(args, ++i, "--out");
    else if (arg === "--parallel") options.parallel = Number(requireValue(args, ++i, "--parallel"));
    else if (arg === "--timeout") options.timeoutSec = Number(requireValue(args, ++i, "--timeout"));
    else if (arg === "--stall") options.stallSec = Number(requireValue(args, ++i, "--stall"));
    else if (arg === "--codex-home") options.codexHome = requireValue(args, ++i, "--codex-home");
    else if (arg === "--bin") options.bin = requireValue(args, ++i, "--bin");
    else if (arg === "--resume") options.resume = true;
    else throw new Error(`unknown run option: ${arg}`);
  }

  if (!tasksPath) throw new Error("run requires --tasks <tasks.jsonl>");
  if (!outDir) throw new Error("run requires --out <dir>");
  return { tasksPath, outDir: resolve(outDir), options: { ...options, outDir: resolve(outDir) } };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readTasks(path: string): TaskSpec[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as TaskSpec;
      } catch (error) {
        throw new Error(`invalid JSON on ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function printHelp(): void {
  console.log(`codex-subagents

Usage:
  codex-subagents run --tasks <tasks.jsonl> --out <dir> [--parallel N] [--timeout S] [--stall S] [--resume]
  codex-subagents doctor [--json]`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === modulePath) {
  void main(process.argv.slice(2));
}
