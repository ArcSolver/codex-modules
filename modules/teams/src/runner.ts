import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SandboxMode, TeamDef } from "./types.js";
import { findCodexBinary, resolveCodexHome } from "./agents.js";
import type { HarnessProfile } from "./harness.js";
import { nativeV1Harness } from "./harness.js";
import { parseTeamJson } from "./team.js";
import { assembleLeaderPrompt } from "./prompt.js";
import { resolveStateRoot, writeJsonAtomic } from "./state.js";

export type RunOptions = {
  goal: string;
  codexHome?: string;
  sandbox?: SandboxMode;
  timeoutSec?: number;
  stallSec?: number;
  execute?: boolean;
  allowCodex?: boolean;
  cwd?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export type DryRunPlan = {
  mode: "dry-run";
  argv: string[];
  prompt: string;
  runDir: string;
};

export type RunResult = {
  mode: "executed";
  status: "ok" | "error" | "timeout" | "stall";
  exitCode: number | null;
  argv: string[];
  runDir: string;
  eventsPath: string;
  lastMessagePath: string;
  summaryPath: string;
};

export function buildRunPlan(teamPath: string, opts: RunOptions, profile: HarnessProfile = nativeV1Harness): DryRunPlan {
  const team = parseTeamJson(teamPath);
  const prompt = assembleLeaderPrompt(team, opts.goal, profile);
  const runDir = resolveRunDir(team, opts);
  return {
    mode: "dry-run",
    argv: profile.transport.runnerArgv(prompt, runDir, opts),
    prompt,
    runDir,
  };
}

export async function runTeam(teamPath: string, opts: RunOptions, profile: HarnessProfile = nativeV1Harness): Promise<DryRunPlan | RunResult> {
  assertSafeRunOptions(opts);
  const plan = buildRunPlan(teamPath, opts, profile);
  if (!opts.execute || !opts.allowCodex) return plan;
  if ((opts.sandbox ?? "workspace-write") === "read-only") {
    throw new Error("executed team runs require workspace-write because the leader writes .codex-teams state");
  }
  const bin = findCodexBinary(opts.env);
  if (!bin) throw new Error("codex binary not found");
  mkdirSync(plan.runDir, { recursive: true });
  const eventsPath = join(plan.runDir, "events.jsonl");
  const stderrPath = join(plan.runDir, "stderr.log");
  const lastMessagePath = join(plan.runDir, "last-message.md");
  const summaryPath = join(plan.runDir, "summary.json");
  const startedAt = Date.now();
  let exitCode: number | null = null;
  let status: RunResult["status"] | null = null;

  await new Promise<void>(resolve => {
    const devNullFd = openSync("/dev/null", "r");
    const events = createWriteStream(eventsPath, { flags: "a" });
    const stderr = createWriteStream(stderrPath, { flags: "a" });
    const child = spawn(bin, plan.argv, {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        CODEX_HOME: resolveCodexHome(opts.env, opts.codexHome),
      },
      stdio: [devNullFd, "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      status = "error";
      child.kill("SIGTERM");
      closeFd(devNullFd);
      events.end(() => stderr.end(() => resolve()));
      return;
    }
    child.stdout.pipe(events);
    child.stderr.pipe(stderr);
    const timeoutTimer = setTimeout(() => {
      status = "timeout";
      child.kill("SIGTERM");
    }, (opts.timeoutSec ?? 600) * 1000);
    const stallTimer = setInterval(() => {
      if (Date.now() - latestMtimeMs([eventsPath, stderrPath, lastMessagePath], startedAt) > (opts.stallSec ?? 180) * 1000) {
        status = "stall";
        child.kill("SIGTERM");
      }
    }, 1000);
    child.once("error", () => {
      status = "error";
    });
    child.once("close", code => {
      exitCode = code;
      clearTimeout(timeoutTimer);
      clearInterval(stallTimer);
      closeFd(devNullFd);
      events.end(() => stderr.end(() => resolve()));
    });
  });

  if (!status) status = exitCode === 0 ? "ok" : "error";
  writeJsonAtomic(summaryPath, profile.transport.summarize(eventsPath, { status, exitCode, teamPath: basename(teamPath) }));
  return { mode: "executed", status, exitCode, argv: plan.argv, runDir: plan.runDir, eventsPath, lastMessagePath, summaryPath };
}

function resolveRunDir(team: TeamDef, opts: RunOptions): string {
  const safeStamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(resolveStateRoot({ cwd: opts.cwd, stateDir: opts.stateDir, env: opts.env }), team.name, "runs", safeStamp);
}

function assertSafeRunOptions(opts: RunOptions): void {
  if (!opts.goal || !opts.goal.trim()) throw new Error("--goal is required");
  if (opts.sandbox !== undefined && opts.sandbox !== "read-only" && opts.sandbox !== "workspace-write") throw new Error("sandbox must be read-only or workspace-write");
  if (opts.timeoutSec !== undefined && (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0)) throw new Error("timeout-sec must be > 0");
  if (opts.stallSec !== undefined && (!Number.isFinite(opts.stallSec) || opts.stallSec <= 0)) throw new Error("stall-sec must be > 0");
}

function latestMtimeMs(paths: string[], fallback: number): number {
  let latest = fallback;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      // file may not exist yet
    }
  }
  return latest;
}

function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best effort
  }
}
