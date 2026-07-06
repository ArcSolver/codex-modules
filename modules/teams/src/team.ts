import { readFileSync, writeFileSync } from "node:fs";
import type { MemberDef, SandboxMode, TeamDef } from "./types.js";

export const TEAM_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
export const MEMBER_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SANDBOXES = new Set<SandboxMode>(["read-only", "workspace-write"]);
const LENSES = new Set(["area", "ownership", "perspective"]);

export function parseTeamJson(path: string): TeamDef {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateTeamDef(parsed, path);
}

export function validateTeamDef(value: unknown, label = "team.json"): TeamDef {
  const errors = collectTeamErrors(value);
  if (errors.length > 0) throw new Error(`${label} is invalid:\n- ${errors.join("\n- ")}`);
  return value as TeamDef;
}

export function collectTeamErrors(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["team definition must be an object"];

  if (value.version !== 1) errors.push("version must be 1");
  if (typeof value.name !== "string" || !TEAM_NAME_RE.test(value.name)) {
    errors.push("name must match ^[a-z][a-z0-9-]{0,40}$");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    errors.push("description must be a string when present");
  }

  if (value.defaults !== undefined) {
    if (!isRecord(value.defaults)) errors.push("defaults must be an object when present");
    else {
      if (value.defaults.model !== undefined && value.defaults.model !== null && !nonEmptyString(value.defaults.model)) {
        errors.push("defaults.model must be a non-empty string when present");
      }
      if (
        value.defaults.sandbox_mode !== undefined &&
        value.defaults.sandbox_mode !== null &&
        !SANDBOXES.has(value.defaults.sandbox_mode as SandboxMode)
      ) {
        errors.push("defaults.sandbox_mode must be read-only or workspace-write");
      }
    }
  }

  if (!Array.isArray(value.members)) {
    errors.push("members must be an array");
    return errors;
  }
  if (value.members.length < 2 || value.members.length > 8) errors.push("members must contain 2 to 8 entries");
  const seen = new Set<string>();
  value.members.forEach((member, index) => {
    const prefix = `members[${index}]`;
    if (!isRecord(member)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (typeof member.name !== "string" || !MEMBER_NAME_RE.test(member.name)) {
      errors.push(`${prefix}.name must match ^[a-z][a-z0-9-]{0,30}$`);
    } else if (seen.has(member.name)) {
      errors.push(`${prefix}.name duplicates ${member.name}`);
    } else {
      seen.add(member.name);
    }
    if (!nonEmptyString(member.focus)) errors.push(`${prefix}.focus is required`);
    if (!LENSES.has(String(member.lens))) errors.push(`${prefix}.lens must be area, ownership, or perspective`);
    if (!nonEmptyString(member.deliverable)) errors.push(`${prefix}.deliverable is required`);
    if (member.model !== undefined && member.model !== null && !nonEmptyString(member.model)) {
      errors.push(`${prefix}.model must be a non-empty string when present`);
    }
    if (
      member.sandbox_mode !== undefined &&
      member.sandbox_mode !== null &&
      !SANDBOXES.has(member.sandbox_mode as SandboxMode)
    ) {
      errors.push(`${prefix}.sandbox_mode must be read-only or workspace-write`);
    }
    if (member.instructions !== undefined && member.instructions !== null && typeof member.instructions !== "string") {
      errors.push(`${prefix}.instructions must be a string when present`);
    }
  });

  return errors;
}

export function scaffoldTeam(preset: "review-panel" | "swarm" | "pipeline" = "review-panel"): TeamDef {
  if (preset === "swarm") {
    return {
      version: 1,
      name: "swarm",
      description: "Parallel exploration team",
      defaults: { model: "gpt-5.4-mini", sandbox_mode: "read-only" },
      members: [1, 2, 3].map(n => ({
        name: `explorer-${n}`,
        focus: `independent exploration slice ${n}`,
        lens: "area",
        deliverable: "concise evidence-backed notes with file references",
      })) as MemberDef[],
    };
  }
  if (preset === "pipeline") {
    return {
      version: 1,
      name: "pipeline",
      description: "Builder and verifier gated workflow",
      defaults: { model: "gpt-5.4-mini", sandbox_mode: "workspace-write" },
      members: [
        {
          name: "builder",
          focus: "smallest implementation that satisfies the requested contract",
          lens: "ownership",
          deliverable: "changed files and verification notes",
        },
        {
          name: "verifier",
          focus: "behavioral regressions, missing tests, and contract drift",
          lens: "perspective",
          deliverable: "pass/fail findings with exact reproduction steps",
          sandbox_mode: "read-only",
        },
      ],
    };
  }
  return {
    version: 1,
    name: "review-panel",
    description: "Adversarial review panel",
    defaults: { model: "gpt-5.4-mini", sandbox_mode: "read-only" },
    members: [
      {
        name: "security",
        focus: "auth, injection, filesystem, and permission surfaces of the change",
        lens: "perspective",
        deliverable: "findings list with file:line, severity, and exploit path",
      },
      {
        name: "correctness",
        focus: "runtime behavior, edge cases, and data contract mismatches",
        lens: "area",
        deliverable: "reproducible bugs with expected versus actual behavior",
      },
      {
        name: "simplicity",
        focus: "unnecessary abstractions, ownership confusion, and deletion opportunities",
        lens: "ownership",
        deliverable: "specific simplifications and the files they affect",
      },
    ],
  };
}

export function writePreset(path: string, preset: "review-panel" | "swarm" | "pipeline"): void {
  writeFileSync(path, `${JSON.stringify(scaffoldTeam(preset), null, 2)}\n`, { mode: 0o600 });
}

export function memberAgentName(team: TeamDef | string, member: MemberDef | string): string {
  const teamName = typeof team === "string" ? team : team.name;
  const memberName = typeof member === "string" ? member : member.name;
  if (!TEAM_NAME_RE.test(teamName)) throw new Error(`invalid team name: ${teamName}`);
  if (!MEMBER_NAME_RE.test(memberName)) throw new Error(`invalid member name: ${memberName}`);
  return `${teamName}-${memberName}`;
}

export function resolveMemberModel(team: TeamDef, member: MemberDef): string {
  const model = member.model ?? team.defaults?.model;
  if (!model) throw new Error(`member ${member.name} has no model and defaults.model is not set`);
  return model;
}

export function resolveMemberSandbox(team: TeamDef, member: MemberDef): SandboxMode {
  return member.sandbox_mode ?? team.defaults?.sandbox_mode ?? "read-only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
