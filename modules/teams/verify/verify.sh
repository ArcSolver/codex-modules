#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
NODE_BIN="$(command -v node)"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
run() { "$NODE_BIN" "$CLI" "$@"; }
assert_file() { [[ -f "$1" ]] || fail "missing file: $1"; }
assert_grep() { grep -F -- "$2" "$1" >/dev/null || fail "missing pattern in $1: $2"; }
assert_not_exists() { [[ ! -e "$1" ]] || fail "expected absent: $1"; }

[[ -f "$CLI" ]] || fail "dist/cli.js is missing; run npm run build first"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-teams-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

export CODEX_HOME="$TMP/codex-home"
PROJECT="$TMP/project"
mkdir -p "$CODEX_HOME" "$PROJECT/.git"
cd "$PROJECT"

run init --preset review-panel --out generated-team.json >/tmp/codex-teams-init.out
run validate generated-team.json >/tmp/codex-teams-validate.out
pass "init and validate preset"

cat >invalid-team.json <<'JSON'
{"version":1,"name":"Bad_Name","members":[]}
JSON
if run validate invalid-team.json >/tmp/codex-teams-invalid.out 2>&1; then
  fail "invalid team unexpectedly validated"
fi
pass "validate rejects invalid name and member count"

cat >team.json <<'JSON'
{
  "version": 1,
  "name": "review-panel",
  "description": "Review panel",
  "defaults": {
    "model": "gpt-5.4-mini",
    "sandbox_mode": "read-only"
  },
  "members": [
    {
      "name": "security",
      "focus": "Auth \"quotes\" and newline\nsecond line",
      "lens": "perspective",
      "deliverable": "findings list with file:line and severity"
    },
    {
      "name": "correctness",
      "focus": "Runtime edge cases",
      "lens": "area",
      "deliverable": "bugs with reproduction steps",
      "sandbox_mode": "workspace-write"
    }
  ]
}
JSON

run install team.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-install.out
SECURITY_TOML="$CODEX_HOME/agents/review-panel-security.toml"
CORRECTNESS_TOML="$CODEX_HOME/agents/review-panel-correctness.toml"
MANIFEST="$CODEX_HOME/agents/.codex-teams-manifest.json"
assert_file "$SECURITY_TOML"
assert_file "$CORRECTNESS_TOML"
assert_file "$MANIFEST"
assert_grep "$SECURITY_TOML" 'description = "Auth \"quotes\" and newline\nsecond line"'
assert_grep "$SECURITY_TOML" 'nickname_candidates = ["security"]'
assert_grep "$SECURITY_TOML" 'TEAM-RESULT: <one-line summary>'
assert_grep "$CORRECTNESS_TOML" '.codex-teams/review-panel/artifacts/correctness/'
pass "install writes escaped TOML and manifest"

run install team.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-reinstall.out
pass "reinstall is idempotent for managed files"

cat >rogue.json <<'JSON'
{
  "version": 1,
  "name": "rogue",
  "defaults": {"model": "gpt-5.4-mini", "sandbox_mode": "read-only"},
  "members": [
    {"name": "alpha", "focus": "alpha", "lens": "area", "deliverable": "alpha report"},
    {"name": "beta", "focus": "beta", "lens": "area", "deliverable": "beta report"}
  ]
}
JSON
mkdir -p "$CODEX_HOME/agents"
printf 'unmanaged\n' >"$CODEX_HOME/agents/rogue-alpha.toml"
if run install rogue.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-rogue.out 2>&1; then
  fail "install overwrote unmanaged file without --force"
fi
pass "install refuses unmanaged collision without force"

run uninstall review-panel --codex-home "$CODEX_HOME" >/tmp/codex-teams-uninstall.out
assert_not_exists "$SECURITY_TOML"
assert_not_exists "$CORRECTNESS_TOML"
pass "uninstall removes only manifest-owned files"

CODEX_TEAMS_NOW="2026-01-01T00:00:00.000Z" run state init review-panel --goal "verify goal" >/tmp/codex-teams-state-init.json
assert_file "$PROJECT/.codex-teams/.gitignore"
assert_file "$PROJECT/.codex-teams/review-panel/state.json"
assert_file "$PROJECT/.codex-teams/review-panel/tasks.json"
pass "state init creates durable state and gitignore"

TASK_A="$(run task add review-panel --title "A" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
TASK_B="$(run task add review-panel --title "B" --depends-on "$TASK_A" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
if run task claim review-panel "$TASK_B" --actor correctness >/tmp/codex-teams-claim-dep.out 2>&1; then
  fail "claimed task with incomplete dependency"
fi
CODEX_TEAMS_NOW="2026-01-01T00:01:00.000Z" run task claim review-panel "$TASK_A" --actor security --lease-sec 60 >/tmp/codex-teams-claim-a.json
CODEX_TEAMS_NOW="2026-01-01T00:01:30.000Z" run task complete review-panel "$TASK_A" --actor security --result "done" >/tmp/codex-teams-complete-a.json
CODEX_TEAMS_NOW="2026-01-01T00:02:00.000Z" run task claim review-panel "$TASK_B" --actor correctness --lease-sec 60 >/tmp/codex-teams-claim-b.json
pass "task dependency gate and completion flow"

TASK_C="$(run task add review-panel --title "lease" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
CODEX_TEAMS_NOW="2026-01-01T00:03:00.000Z" run task claim review-panel "$TASK_C" --actor security --lease-sec 1 >/tmp/codex-teams-claim-c.json
CODEX_TEAMS_NOW="2026-01-01T00:03:02.000Z" run task list review-panel --json --reclaim >/tmp/codex-teams-reclaim.json
"$NODE_BIN" -e 'const f=require("fs");const data=JSON.parse(f.readFileSync(process.argv[1],"utf8"));const t=data.tasks.find(x=>x.title==="lease");if(!t||t.status!=="open")process.exit(1)' /tmp/codex-teams-reclaim.json || fail "expired lease was not reclaimed"
pass "lease expiry reclaim"

TASK_D="$(run task add review-panel --title "race" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
set +e
run task claim review-panel "$TASK_D" --actor security --lease-sec 60 >/tmp/codex-teams-race-1.out 2>/tmp/codex-teams-race-1.err &
PID1=$!
run task claim review-panel "$TASK_D" --actor correctness --lease-sec 60 >/tmp/codex-teams-race-2.out 2>/tmp/codex-teams-race-2.err &
PID2=$!
wait "$PID1"; R1=$?
wait "$PID2"; R2=$?
set -e
if [[ $(( (R1 == 0) + (R2 == 0) )) -ne 1 ]]; then
  fail "concurrent claim did not produce exactly one winner"
fi
pass "concurrent claim single winner"

run note add review-panel --actor security --kind decision --text "ship it carefully" >/tmp/codex-teams-note.json
run note list review-panel --json >/tmp/codex-teams-notes.json
assert_grep /tmp/codex-teams-notes.json "ship it carefully"
run state show review-panel --json >/tmp/codex-teams-state-show.json
assert_grep /tmp/codex-teams-state-show.json '"team": "review-panel"'
pass "note journal and state show json"

run leader-prompt team.json --goal "verify goal" >/tmp/codex-teams-leader.txt
assert_grep /tmp/codex-teams-leader.txt "tool_search"
assert_grep /tmp/codex-teams-leader.txt "TEAM-RESULT"
assert_grep /tmp/codex-teams-leader.txt "multi_agent_v1.spawn_agent"
pass "leader prompt includes roster and native tool contract"

run run team.json --goal "verify goal" >/tmp/codex-teams-dry-run.txt
assert_grep /tmp/codex-teams-dry-run.txt "DRY-RUN codex argv"
assert_grep /tmp/codex-teams-dry-run.txt "--ephemeral"
assert_grep /tmp/codex-teams-dry-run.txt "workspace-write"
pass "run dry-run prints ephemeral argv without executing codex"

mkdir -p "$TMP/no-bin"
set +e
PATH="$TMP/no-bin" "$NODE_BIN" "$CLI" doctor --codex-home "$CODEX_HOME" >/tmp/codex-teams-doctor.out 2>&1
DOCTOR_STATUS=$?
set -e
if [[ "$DOCTOR_STATUS" -eq 0 ]]; then
  fail "doctor succeeded without codex binary"
fi
assert_grep /tmp/codex-teams-doctor.out "codex binary: not found"
pass "doctor fails clearly when codex is absent"

printf 'PASS verify.sh complete\n'
