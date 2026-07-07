---
name: teams
description: Use when a task should be handled by a declared Codex team with native stable multi-agent collaboration, durable task leases, and a leader-owned journal.
---

# Codex Teams

Use this skill when the user asks for a team, panel, swarm, or parallel collaboration and a local team definition is available.

1. Find a team definition in ./team.json first, then .codex-teams/*/team.json if present.
2. If the team is not installed, tell the user to run codex-teams install <team.json>. Do not edit trust or config.toml automatically.
3. Load the native multi-agent tools with tool_search. Use stable multi_agent_v1.spawn_agent, wait, close, resume, and send_input only.
4. Start durable state with codex-teams state init <team> --goal "<goal>" before spawning members.
5. After each spawn, record the returned id with codex-teams member bind <team> <member> --agent-id <id> --nickname <nick>.
6. Use codex-teams task add/claim/complete/fail and codex-teams note add/list for leader-owned state. Members should report through their final TEAM-RESULT line.
7. Use wait to collect member results, inspect any optional artifacts, and integrate the final answer yourself.
8. Finish with codex-teams state finish <team> --status ok or --status partial.

Do not use codex_app.*, spawn_agents_on_csv, multi_agent_v2, or automatic trust mutation for this MVP workflow.
