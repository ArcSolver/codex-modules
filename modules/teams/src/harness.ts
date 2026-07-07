import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorReport, MemberDef, TeamDef } from "./types.js";
import type { RunOptions } from "./runner.js";
import { resolveMemberSandbox } from "./team.js";

/** @experimental 어댑터 2호 도착 전까지 형태 변경 가능, semver 보증 밖. */
export type TransportSpec = {
  kind: "native-multi-agent-v1";
  leaderToolInstructions(): string[];
  forbidden(): string[];
  runnerArgv(prompt: string, runDir: string, opts: RunOptions): string[];
  healthy(report: DoctorReport): boolean;
  summarize(eventsPath: string, base: Record<string, unknown>): Record<string, unknown>;
};

/** @experimental 어댑터 2호 도착 전까지 형태 변경 가능, semver 보증 밖. */
export type DisciplineSpec = {
  kind: "leader-owned-state";
  resultMarker: string;
  memberContract(team: TeamDef, member: MemberDef): string[];
  leaderStateContract(team: TeamDef, goal: string): string[];
  skillStateFragment(): string;
};

/** @experimental 어댑터 2호 도착 전까지 형태 변경 가능, semver 보증 밖. */
export type HarnessProfile = {
  transport: TransportSpec;
  discipline: DisciplineSpec;
};

/** @experimental 어댑터 2호 도착 전까지 형태 변경 가능, semver 보증 밖. */
export const nativeV1Harness: HarnessProfile = {
  transport: {
    kind: "native-multi-agent-v1",
    leaderToolInstructions: () => [
      "Use the stable native multi-agent tool path only:",
      "1. Load tools with tool_search for multi_agent_v1.spawn_agent, wait, close, resume, and send_input.",
    ],
    forbidden: () => ["Do not use codex_app.*, spawn_agents_on_csv, multi_agent_v2, or trust/config mutation for this MVP workflow."],
    runnerArgv: (prompt, runDir, opts) => buildNativeV1RunnerArgv(prompt, runDir, opts),
    healthy: report => Boolean(report.codexBinary && report.multiAgent.present && report.multiAgent.stage === "stable" && report.multiAgent.enabled),
    summarize: (eventsPath, base) => summarizeNativeV1Events(eventsPath, base),
  },
  discipline: {
    kind: "leader-owned-state",
    resultMarker: "TEAM-RESULT:",
    memberContract: (team, member) => {
      const sandbox = resolveMemberSandbox(team, member);
      const lines = [
        `You are team member "${member.name}" of team "${team.name}". Focus: ${member.focus}. Lens: ${member.lens}. Deliverable: ${member.deliverable}.`,
        `Return your final report with the last line exactly in this format: TEAM-RESULT: <one-line summary>.`,
        `Do not call codex-teams task or note commands yourself; the leader owns durable state updates.`,
      ];
      if (sandbox === "workspace-write") {
        lines.push(
          `You may also write supporting artifacts under .codex-teams/${team.name}/artifacts/${member.name}/, but the TEAM-RESULT final line remains the canonical result channel.`,
        );
      }
      if (member.instructions && member.instructions.trim()) lines.push(member.instructions.trim());
      return lines;
    },
    leaderStateContract: (team, goal) => [
      `2. Start durable state before spawning: codex-teams state init ${team.name} --goal ${shellQuote(goal)}`,
      `3. After each spawn, record the returned agent id: codex-teams member bind ${team.name} <member> --agent-id <id> --nickname <nick>`,
      "4. Track work with codex-teams task add, task claim, task complete, and task fail. Use codex-teams note add for shared observations.",
      "5. Spawn only independent tasks concurrently. Join with wait. If a member fails, close it and return its claimed task to a safe state.",
      "6. Treat each member's final TEAM-RESULT line as the canonical result. Artifact files are optional supporting evidence for workspace-write members.",
      `7. Integrate and verify the final answer yourself. Finish with: codex-teams state finish ${team.name} --status ok or --status partial.`,
    ],
    skillStateFragment: () => `1. Find a team definition in ./team.json first, then .codex-teams/*/team.json if present.
2. If the team is not installed, tell the user to run codex-teams install <team.json>. Do not edit trust or config.toml automatically.
3. Load the native multi-agent tools with tool_search. Use stable multi_agent_v1.spawn_agent, wait, close, resume, and send_input only.
4. Start durable state with codex-teams state init <team> --goal "<goal>" before spawning members.
5. After each spawn, record the returned id with codex-teams member bind <team> <member> --agent-id <id> --nickname <nick>.
6. Use codex-teams task add/claim/complete/fail and codex-teams note add/list for leader-owned state. Members should report through their final TEAM-RESULT line.
7. Use wait to collect member results, inspect any optional artifacts, and integrate the final answer yourself.
8. Finish with codex-teams state finish <team> --status ok or --status partial.

Do not use codex_app.*, spawn_agents_on_csv, multi_agent_v2, or automatic trust mutation for this MVP workflow.`,
  },
};

function buildNativeV1RunnerArgv(prompt: string, runDir: string, opts: RunOptions): string[] {
  const sandbox = opts.sandbox ?? "workspace-write";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("sandbox must be read-only or workspace-write");
  return [
    "exec",
    "-s",
    sandbox,
    "--skip-git-repo-check",
    "--json",
    "--ephemeral",
    "-o",
    join(runDir, "last-message.md"),
    prompt,
  ];
}

function summarizeNativeV1Events(path: string, base: Record<string, unknown>): Record<string, unknown> {
  const collabToolCalls: unknown[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        if (JSON.stringify(item).includes("collab_tool_call")) collabToolCalls.push(item);
      } catch {
        // ignore non-JSON event lines
      }
    }
  } else {
    writeFileSync(path, "");
  }
  return { ...base, collabToolCallCount: collabToolCalls.length, collabToolCalls };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
