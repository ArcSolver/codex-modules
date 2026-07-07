import type { MemberDef, TeamDef } from "./types.js";
import { memberAgentName } from "./team.js";
import type { HarnessProfile } from "./harness.js";
import { nativeV1Harness } from "./harness.js";

export function assembleDeveloperInstructions(team: TeamDef, member: MemberDef, profile: HarnessProfile = nativeV1Harness): string {
  const lines = profile.discipline.memberContract(team, member);
  return `${lines.join("\n\n")}\n`;
}

export function assembleLeaderPrompt(team: TeamDef, goal: string, profile: HarnessProfile = nativeV1Harness): string {
  const roster = team.members
    .map(member => `- ${member.name}: agent_type=${memberAgentName(team, member)}; focus=${member.focus}; deliverable=${member.deliverable}`)
    .join("\n");
  return renderLeaderPrompt([
    [`You are the leader for Codex team "${team.name}".`, "", "Goal:", goal, "", "Roster:", roster, ""],
    profile.transport.leaderToolInstructions(),
    profile.discipline.leaderStateContract(team, goal),
    [""],
    profile.transport.forbidden(),
  ]);
}

function renderLeaderPrompt(sections: string[][]): string {
  return `${sections.flat().join("\n")}\n`;
}
