#!/usr/bin/env bash
# Golden output generator: renders the deterministic harness surfaces from the
# current build into $1 (default: verify/golden). verify.sh compares a fresh
# render against the committed baselines to enforce move-only refactors.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-verify/golden}"
mkdir -p "$OUT"
FIX="verify/golden/team.fixture.json"

node dist/cli.js leader-prompt "$FIX" --goal "Golden baseline goal with 'single quotes'" > "$OUT/leader-prompt.golden.txt"

node -e '
import("./dist/team.js").then(async t => {
  const p = await import("./dist/prompt.js");
  const team = t.parseTeamJson("verify/golden/team.fixture.json");
  for (const member of team.members) {
    process.stdout.write("=== " + member.name + " ===\n" + p.assembleDeveloperInstructions(team, member) + "\n");
  }
});' > "$OUT/member-instructions.golden.txt"

node -e '
import("./dist/skill.js").then(m => process.stdout.write(m.renderTeamsSkill()));' > "$OUT/skill.golden.md"

node -e '
import("./dist/runner.js").then(m => {
  const plan = m.buildRunPlan("verify/golden/team.fixture.json", { goal: "Golden baseline goal", stateDir: "/tmp/golden-state" });
  const argv = plan.argv.map(a =>
    a === plan.prompt ? "<PROMPT>" : a.replace(/runs\/[0-9TZ.-]+/, "runs/<TS>"),
  );
  process.stdout.write(JSON.stringify(argv, null, 2) + "\n");
});' > "$OUT/argv.golden.json"

node -e '
import("./dist/doctor.js").then(m => {
  const report = {
    codexBinary: "/opt/fixture/bin/codex",
    version: "0.142.5",
    features: [],
    multiAgent: { present: true, stage: "stable", enabled: true },
    fanout: { present: true, stage: "underDevelopment", enabled: false },
    multiAgentV2: { present: true, stage: "underDevelopment", enabled: false },
    models: { ok: true, values: ["gpt-5.4-mini"] },
    agentsDirWritable: true,
    stateDirWritable: true,
    userInstalledTeams: ["golden"],
    projectInstalledTeams: [],
  };
  process.stdout.write(m.formatDoctor(report) + "healthy: " + m.doctorIsHealthy(report) + "\n");
});' > "$OUT/doctor.golden.txt"

echo "golden outputs written to $OUT"
