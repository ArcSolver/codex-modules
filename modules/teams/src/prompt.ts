import type { MemberDef, TeamDef } from "./types.js";
import { memberAgentName, resolveMemberSandbox } from "./team.js";

export function assembleDeveloperInstructions(team: TeamDef, member: MemberDef): string {
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
  return `${lines.join("\n\n")}\n`;
}

export function assembleLeaderPrompt(team: TeamDef, goal: string): string {
  const roster = team.members
    .map(member => `- ${member.name}: agent_type=${memberAgentName(team, member)}; focus=${member.focus}; deliverable=${member.deliverable}`)
    .join("\n");
  return `You are the leader for Codex team "${team.name}".

Goal:
${goal}

Roster:
${roster}

Use the stable native multi-agent tool path only:
1. Load tools with tool_search for multi_agent_v1.spawn_agent, wait, close, resume, and send_input.
2. Start durable state before spawning: codex-teams state init ${team.name} --goal ${shellQuote(goal)}
3. After each spawn, record the returned agent id: codex-teams member bind ${team.name} <member> --agent-id <id> --nickname <nick>
4. Track work with codex-teams task add, task claim, task complete, and task fail. Use codex-teams note add for shared observations.
5. Spawn only independent tasks concurrently. Join with wait. If a member fails, close it and return its claimed task to a safe state.
6. Treat each member's final TEAM-RESULT line as the canonical result. Artifact files are optional supporting evidence for workspace-write members.
7. Integrate and verify the final answer yourself. Finish with: codex-teams state finish ${team.name} --status ok or --status partial.

Do not use codex_app.*, spawn_agents_on_csv, multi_agent_v2, or trust/config mutation for this MVP workflow.
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
