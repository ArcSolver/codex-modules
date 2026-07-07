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

GOLDEN_TMP="$TMP/golden"
"$ROOT/verify/golden/generate.sh" "$GOLDEN_TMP" >/tmp/codex-teams-golden-generate.out
for golden_file in leader-prompt.golden.txt member-instructions.golden.txt skill.golden.md argv.golden.json doctor.golden.txt; do
  diff -u "$ROOT/verify/golden/$golden_file" "$GOLDEN_TMP/$golden_file" >/tmp/codex-teams-golden-diff.out || fail "golden drift: $golden_file"
done
pass "golden outputs match committed baselines"

"$NODE_BIN" --input-type=module -e 'const {pathToFileURL}=await import("node:url");const mod=await import(pathToFileURL(process.argv[1]).href);const summary=mod.nativeV1Harness.transport.summarize(process.argv[2],{status:"ok"});if(summary.collabToolCallCount!==1)process.exit(1)' "$ROOT/dist/index.js" "$ROOT/verify/golden/events.fixture.jsonl" || fail "nativeV1 summarize collab_tool_call count drifted"
pass "nativeV1 summarize counts collab_tool_call events"

export CODEX_HOME="$TMP/codex-home"
PROJECT="$TMP/project"
mkdir -p "$CODEX_HOME" "$PROJECT/.git"
cd "$PROJECT"

FAKE_BIN="$TMP/fake-bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/codex" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf 'codex fake 0.0.0\n'
  exit 0
fi
if [[ "${1:-}" == "features" && "${2:-}" == "list" ]]; then
  printf 'multi_agent stable true\n'
  printf 'enable_fanout experimental false\n'
  printf 'multi_agent_v2 experimental false\n'
  exit 0
fi
if [[ "${1:-}" == "debug" && "${2:-}" == "models" ]]; then
  if [[ -n "${CODEX_DEBUG_MODELS:-}" ]]; then
    printf '%s\n' "$CODEX_DEBUG_MODELS"
  else
    printf '%s\n' '{"models":[{"slug":"gpt-5.4-mini"}]}'
  fi
  exit 0
fi
exit 2
SH
chmod +x "$FAKE_BIN/codex"

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

set +e
run validate team.json --nope >/tmp/codex-teams-unknown-bool.out 2>&1
UNKNOWN_BOOL_STATUS=$?
set -e
if [[ "$UNKNOWN_BOOL_STATUS" -eq 0 ]]; then
  fail "unknown bool flag unexpectedly succeeded"
fi
assert_grep /tmp/codex-teams-unknown-bool.out "unknown flag --nope for 'validate'"
pass "unknown bool flag is rejected"

set +e
run validate team.json --nope=1 >/tmp/codex-teams-unknown-value.out 2>&1
UNKNOWN_VALUE_STATUS=$?
set -e
if [[ "$UNKNOWN_VALUE_STATUS" -eq 0 ]]; then
  fail "unknown value flag unexpectedly succeeded"
fi
assert_grep /tmp/codex-teams-unknown-value.out "unknown flag --nope for 'validate'"
pass "unknown equals flag is rejected"

set +e
run run team.json --goal "verify goal" --dangerously-bypass-something >/tmp/codex-teams-dangerous-unknown.out 2>&1
DANGEROUS_UNKNOWN_STATUS=$?
set -e
if [[ "$DANGEROUS_UNKNOWN_STATUS" -eq 0 ]]; then
  fail "dangerously-prefixed unknown flag unexpectedly succeeded"
fi
assert_grep /tmp/codex-teams-dangerous-unknown.out "unknown flag --dangerously-bypass-something for 'run'"
pass "dangerously-prefixed unknown flag is rejected generically"

run validate team.json -- --nope >/tmp/codex-teams-double-dash.out 2>&1
pass "double dash preserves trailing positional args"

run run team.json --goal "verify goal" -s workspace-write >/tmp/codex-teams-run-short-sandbox.out 2>&1
assert_grep /tmp/codex-teams-run-short-sandbox.out "DRY-RUN codex argv"
pass "run short sandbox alias accepts workspace-write"

run install team.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-install.out
SECURITY_TOML="$CODEX_HOME/agents/review-panel-security.toml"
CORRECTNESS_TOML="$CODEX_HOME/agents/review-panel-correctness.toml"
SIMPLICITY_TOML="$CODEX_HOME/agents/review-panel-simplicity.toml"
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

cat >team-v2.json <<'JSON'
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
      "name": "simplicity",
      "focus": "Deletion opportunities",
      "lens": "ownership",
      "deliverable": "specific simplifications"
    }
  ]
}
JSON
run install team-v2.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-stale-reinstall.out 2>/tmp/codex-teams-stale-reinstall.err
assert_not_exists "$CORRECTNESS_TOML"
assert_file "$SIMPLICITY_TOML"
"$NODE_BIN" -e 'const f=require("fs");const m=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(m.entries.some(e=>e.member==="correctness"))process.exit(1)' "$MANIFEST" || fail "stale member remained in manifest"
pass "reinstall removes stale managed member files"

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
assert_not_exists "$SIMPLICITY_TOML"
pass "uninstall removes only manifest-owned files"

cat >control-team.json <<'JSON'
{
  "version": 1,
  "name": "control-panel",
  "defaults": {"model": "gpt-5.4-mini", "sandbox_mode": "read-only"},
  "members": [
    {"name": "alpha", "focus": "bad\bchar", "lens": "area", "deliverable": "alpha report"},
    {"name": "beta", "focus": "plain", "lens": "area", "deliverable": "beta report"}
  ]
}
JSON
run install control-team.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-control-install.out
assert_grep "$CODEX_HOME/agents/control-panel-alpha.toml" 'description = "bad\bchar"'
pass "TOML renderer escapes control characters"

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
if run task claim review-panel "$TASK_A" --actor security --lease-sec -1 >/tmp/codex-teams-negative-lease.out 2>&1; then
  fail "negative lease-sec unexpectedly succeeded"
fi
assert_grep /tmp/codex-teams-negative-lease.out "lease-sec must be > 0"
pass "negative numeric flag values reach validation"
CODEX_TEAMS_NOW="2026-01-01T00:01:00.000Z" run task claim review-panel "$TASK_A" --actor security --lease-sec 60 >/tmp/codex-teams-claim-a.json
CODEX_TEAMS_NOW="2026-01-01T00:01:30.000Z" run task complete review-panel "$TASK_A" --actor security --result "done" >/tmp/codex-teams-complete-a.json
CODEX_TEAMS_NOW="2026-01-01T00:02:00.000Z" run task claim review-panel "$TASK_B" --actor correctness --lease-sec 60 >/tmp/codex-teams-claim-b.json
pass "task dependency gate and completion flow"

"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(Object.prototype.hasOwnProperty.call(t,"result_meta"))process.exit(1)' /tmp/codex-teams-complete-a.json || fail "meta-less complete wrote result_meta"
pass "complete without meta omits result_meta"

TASK_META_OBJECT="$(run task add review-panel --title "meta object" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_OBJECT" --actor security >/tmp/codex-teams-meta-object-claim.json
run task complete review-panel "$TASK_META_OBJECT" --actor security --result "object" --meta '{"nested":{"arr":[1,{"ok":true}]},"tags":["a","b"]}' >/tmp/codex-teams-meta-object-complete.json
run task list review-panel --json >/tmp/codex-teams-meta-object-list.json
"$NODE_BIN" -e 'const f=require("fs");const data=JSON.parse(f.readFileSync(process.argv[1],"utf8"));const t=data.tasks.find(x=>x.id===process.argv[2]);if(!t||t.result_meta?.nested?.arr?.[1]?.ok!==true||t.result_meta.tags?.[1]!=="b")process.exit(1)' /tmp/codex-teams-meta-object-list.json "$TASK_META_OBJECT" || fail "nested result_meta did not round-trip"
pass "complete meta preserves nested object and array"

META_STRING="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify("quote \" backslash \\\\ newline\nend"))')"
TASK_META_STRING="$(run task add review-panel --title "meta string" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_STRING" --actor security >/tmp/codex-teams-meta-string-claim.json
run task complete review-panel "$TASK_META_STRING" --actor security --result "string" --meta "$META_STRING" >/tmp/codex-teams-meta-string-complete.json
"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(t.result_meta!=="quote \" backslash \\\\ newline\nend")process.exit(1)' /tmp/codex-teams-meta-string-complete.json || fail "string result_meta did not preserve escapes"
pass "complete meta preserves quotes backslashes and newline"

META_UNICODE="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify("\uD55C\uAE00 \u{1F600}"))')"
TASK_META_UNICODE="$(run task add review-panel --title "meta unicode" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_UNICODE" --actor security >/tmp/codex-teams-meta-unicode-claim.json
run task complete review-panel "$TASK_META_UNICODE" --actor security --result "unicode" --meta "$META_UNICODE" >/tmp/codex-teams-meta-unicode-complete.json
"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(t.result_meta!=="\uD55C\uAE00 \u{1F600}")process.exit(1)' /tmp/codex-teams-meta-unicode-complete.json || fail "unicode result_meta did not round-trip"
pass "complete meta preserves unicode"

TASK_META_INVALID="$(run task add review-panel --title "meta invalid" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_INVALID" --actor security >/tmp/codex-teams-meta-invalid-claim.json
set +e
run task complete review-panel "$TASK_META_INVALID" --actor security --meta '{"bad":' >/tmp/codex-teams-meta-invalid.out 2>&1
META_INVALID_STATUS=$?
set -e
if [[ "$META_INVALID_STATUS" -eq 0 ]]; then
  fail "invalid meta JSON unexpectedly succeeded"
fi
assert_grep /tmp/codex-teams-meta-invalid.out "--meta must be valid JSON"
pass "complete rejects invalid meta JSON"

TASK_META_SCALAR="$(run task add review-panel --title "meta scalar" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_SCALAR" --actor security >/tmp/codex-teams-meta-scalar-claim.json
run task complete review-panel "$TASK_META_SCALAR" --actor security --result "scalar" --meta 42 >/tmp/codex-teams-meta-scalar-complete.json
"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(t.result_meta!==42)process.exit(1)' /tmp/codex-teams-meta-scalar-complete.json || fail "scalar result_meta was not accepted"
pass "complete meta accepts scalar JSON"

TASK_META_DASH="$(run task add review-panel --title "meta dash" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_META_DASH" --actor security >/tmp/codex-teams-meta-dash-claim.json
run task complete review-panel "$TASK_META_DASH" --actor security --result "dash" --meta '"--flag"' >/tmp/codex-teams-meta-dash-complete.json
"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(t.result_meta!=="--flag")process.exit(1)' /tmp/codex-teams-meta-dash-complete.json || fail "dash-prefixed result_meta was parsed as a flag"
pass "complete meta consumes dash-prefixed JSON string as value"

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
run note list review-panel >/tmp/codex-teams-notes.txt
assert_grep /tmp/codex-teams-notes.txt "ship it carefully"
pass "legacy unscoped notes render in text and json"

TASK_NOTE_OTHER="$(run task add review-panel --title "note other" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run note add review-panel --actor security --task "$TASK_B" --kind handoff --text "task scoped note" >/tmp/codex-teams-task-note.json
run note add review-panel --actor correctness --task "$TASK_NOTE_OTHER" --text "other task note" >/tmp/codex-teams-other-task-note.json
"$NODE_BIN" -e 'const f=require("fs");const n=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(n.task_id!==process.argv[2])process.exit(1)' /tmp/codex-teams-task-note.json "$TASK_B" || fail "task-scoped note did not store task_id"
run note list review-panel --json --task "$TASK_B" >/tmp/codex-teams-task-notes-filtered.json
"$NODE_BIN" -e 'const f=require("fs");const notes=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(notes.length!==1||notes[0].text!=="task scoped note"||notes[0].task_id!==process.argv[2])process.exit(1)' /tmp/codex-teams-task-notes-filtered.json "$TASK_B" || fail "task note filter did not isolate task notes"
set +e
run note add review-panel --actor security --task task-missing --text "bad task" >/tmp/codex-teams-task-note-missing.out 2>&1
TASK_NOTE_MISSING_STATUS=$?
set -e
if [[ "$TASK_NOTE_MISSING_STATUS" -eq 0 ]]; then
  fail "note add accepted unknown task id"
fi
assert_grep /tmp/codex-teams-task-note-missing.out "unknown task for note: task-missing"
run note list review-panel --json >/tmp/codex-teams-task-notes-all.json
"$NODE_BIN" -e 'const f=require("fs");const all=JSON.parse(f.readFileSync(process.argv[1],"utf8"));const filtered=JSON.parse(f.readFileSync(process.argv[2],"utf8"));if(all.length<=filtered.length||!all.some(n=>n.text==="ship it carefully"&&!("task_id" in n))||!all.some(n=>n.text==="other task note"))process.exit(1)' /tmp/codex-teams-task-notes-all.json /tmp/codex-teams-task-notes-filtered.json || fail "filtered and unfiltered note lists were not distinct"
pass "task-scoped notes store validate and filter by task"
run state show review-panel --json >/tmp/codex-teams-state-show.json
assert_grep /tmp/codex-teams-state-show.json '"team": "review-panel"'
pass "note journal and state show json"

TASK_REOPEN="$(run task add review-panel --title "reopen claimed" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_REOPEN" --actor security --lease-sec 60 >/tmp/codex-teams-reopen-claim.json
run task reopen review-panel "$TASK_REOPEN" --actor leader >/tmp/codex-teams-reopen.json
"$NODE_BIN" -e 'const f=require("fs");const t=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(t.status!=="open"||"claimed_by" in t||"lease_expires_at" in t)process.exit(1)' /tmp/codex-teams-reopen.json || fail "reopen did not clear claim"
run task claim review-panel "$TASK_REOPEN" --actor correctness --lease-sec 60 >/tmp/codex-teams-reclaim-after-reopen.json
pass "reopen returns claimed task to open and allows reclaim"

TASK_REOPEN_OPEN="$(run task add review-panel --title "reopen open" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
set +e
run task reopen review-panel "$TASK_REOPEN_OPEN" --actor leader >/tmp/codex-teams-reopen-open.out 2>&1
REOPEN_OPEN_STATUS=$?
set -e
if [[ "$REOPEN_OPEN_STATUS" -eq 0 ]]; then
  fail "reopen accepted open task"
fi
assert_grep /tmp/codex-teams-reopen-open.out "already open; only claimed tasks can be reopened"

TASK_REOPEN_DONE="$(run task add review-panel --title "reopen done" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_REOPEN_DONE" --actor security >/tmp/codex-teams-reopen-done-claim.json
run task complete review-panel "$TASK_REOPEN_DONE" --actor security >/tmp/codex-teams-reopen-done-complete.json
set +e
run task reopen review-panel "$TASK_REOPEN_DONE" --actor leader >/tmp/codex-teams-reopen-done.out 2>&1
REOPEN_DONE_STATUS=$?
set -e
if [[ "$REOPEN_DONE_STATUS" -eq 0 ]]; then
  fail "reopen accepted done task"
fi
assert_grep /tmp/codex-teams-reopen-done.out "is done; only claimed tasks can be reopened"

TASK_REOPEN_FAILED="$(run task add review-panel --title "reopen failed" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
run task claim review-panel "$TASK_REOPEN_FAILED" --actor security >/tmp/codex-teams-reopen-failed-claim.json
run task fail review-panel "$TASK_REOPEN_FAILED" --actor security --result "failed" >/tmp/codex-teams-reopen-failed-fail.json
set +e
run task reopen review-panel "$TASK_REOPEN_FAILED" --actor leader >/tmp/codex-teams-reopen-failed.out 2>&1
REOPEN_FAILED_STATUS=$?
set -e
if [[ "$REOPEN_FAILED_STATUS" -eq 0 ]]; then
  fail "reopen accepted failed task"
fi
assert_grep /tmp/codex-teams-reopen-failed.out "is failed; only claimed tasks can be reopened"
pass "reopen rejects open done and failed tasks"

mkdir -p "$PROJECT/.codex-teams/legacy/locks"
cat >"$PROJECT/.codex-teams/legacy/tasks.json" <<'JSON'
{
  "version": 1,
  "tasks": [
    {
      "id": "task-001",
      "title": "old open",
      "depends_on": [],
      "status": "open",
      "created_at": "2025-12-31T00:00:00.000Z",
      "updated_at": "2025-12-31T00:00:00.000Z"
    },
    {
      "id": "task-002",
      "title": "old claimed",
      "depends_on": [],
      "status": "claimed",
      "claimed_by": "alpha",
      "lease_expires_at": "2026-01-01T00:10:00.000Z",
      "created_at": "2025-12-31T00:00:00.000Z",
      "updated_at": "2025-12-31T00:00:00.000Z"
    }
  ]
}
JSON
cat >"$PROJECT/.codex-teams/legacy/journal.jsonl" <<'JSONL'
{"ts":"2025-12-31T00:00:00.000Z","actor":"alpha","kind":"note","text":"old note without task id"}
JSONL
run task list legacy --json >/tmp/codex-teams-legacy-tasks.json
run task complete legacy task-002 --actor alpha --result "legacy done" >/tmp/codex-teams-legacy-complete.json
"$NODE_BIN" -e 'const f=require("fs");const listed=JSON.parse(f.readFileSync(process.argv[1],"utf8"));const done=JSON.parse(f.readFileSync(process.argv[2],"utf8"));if(listed.tasks.length!==2||done.status!=="done"||Object.prototype.hasOwnProperty.call(done,"result_meta"))process.exit(1)' /tmp/codex-teams-legacy-tasks.json /tmp/codex-teams-legacy-complete.json || fail "legacy task schema was not readable or completable"
pass "old task schema reads and completes"
run note list legacy --json >/tmp/codex-teams-legacy-notes.json
run note list legacy >/tmp/codex-teams-legacy-notes.txt
assert_grep /tmp/codex-teams-legacy-notes.json "old note without task id"
assert_grep /tmp/codex-teams-legacy-notes.txt "old note without task id"
pass "old journal schema reads in json and text"

run leader-prompt team.json --goal "verify goal" >/tmp/codex-teams-leader.txt
assert_grep /tmp/codex-teams-leader.txt "tool_search"
assert_grep /tmp/codex-teams-leader.txt "TEAM-RESULT"
assert_grep /tmp/codex-teams-leader.txt "multi_agent_v1.spawn_agent"
assert_grep /tmp/codex-teams-leader.txt "codex-teams task reopen review-panel <task-id> --actor leader"
pass "leader prompt includes roster and native tool contract"

run run team.json --goal "verify goal" >/tmp/codex-teams-dry-run.txt
assert_grep /tmp/codex-teams-dry-run.txt "DRY-RUN codex argv"
assert_grep /tmp/codex-teams-dry-run.txt "--ephemeral"
assert_grep /tmp/codex-teams-dry-run.txt "workspace-write"
pass "run dry-run prints ephemeral argv without executing codex"

run run team.json --goal "Review the auth bypass bug" >/tmp/codex-teams-bypass-dry-run.txt
assert_grep /tmp/codex-teams-bypass-dry-run.txt "DRY-RUN codex argv"
if run run team.json --goal "verify goal" -s danger-full-access >/tmp/codex-teams-danger-sandbox.out 2>&1; then
  fail "danger-full-access sandbox unexpectedly accepted"
fi
assert_grep /tmp/codex-teams-danger-sandbox.out "sandbox must be read-only or workspace-write"
pass "run uses structural sandbox defenses without bypass word overblocking"

env PATH="$FAKE_BIN:$PATH" CODEX_DEBUG_MODELS='Model ownership object list' "$NODE_BIN" "$CLI" doctor --codex-home "$CODEX_HOME" --json >/tmp/codex-teams-doctor-prose.json
"$NODE_BIN" -e 'const f=require("fs");const r=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(r.models.values.includes("ownership")||r.models.values.includes("object"))process.exit(1)' /tmp/codex-teams-doctor-prose.json || fail "prose words were parsed as model IDs"
env PATH="$FAKE_BIN:$PATH" CODEX_DEBUG_MODELS='{"models":[{"slug":"gpt-5.4-mini"},{"id":"o3"}]}' "$NODE_BIN" "$CLI" doctor --codex-home "$CODEX_HOME" --json >/tmp/codex-teams-doctor-models.json
"$NODE_BIN" -e 'const f=require("fs");const r=JSON.parse(f.readFileSync(process.argv[1],"utf8"));for(const id of ["gpt-5.4-mini","o3"])if(!r.models.values.includes(id))process.exit(1)' /tmp/codex-teams-doctor-models.json || fail "JSON model catalog was not parsed"
pass "model catalog parser uses structured JSON only"

run install team.json --scope project --skip-model-check >/tmp/codex-teams-project-install.out 2>/tmp/codex-teams-project-install.err
env PATH="$FAKE_BIN:$PATH" "$NODE_BIN" "$CLI" doctor --codex-home "$CODEX_HOME" --json >/tmp/codex-teams-doctor-project.json
"$NODE_BIN" -e 'const f=require("fs");const r=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(!r.projectInstalledTeams.includes("review-panel"))process.exit(1)' /tmp/codex-teams-doctor-project.json || fail "project installed team was hidden from doctor"
pass "doctor reports project-scope installed teams"

OUTSIDE_MANIFEST_TARGET="$TMP/outside/pwned.toml"
mkdir -p "$TMP/outside" "$PROJECT/.codex/agents"
printf 'owned-by-manifest\n' >"$PROJECT/payload.toml"
cat >"$PROJECT/.codex/agents/.codex-teams-manifest.json" <<JSON
{
  "version": 1,
  "owner": "@codex-modules/teams",
  "entries": [
    {
      "team": "evil",
      "scope": "project",
      "file": "$OUTSIDE_MANIFEST_TARGET",
      "backup": "$PROJECT/payload.toml",
      "hash": "0000",
      "kind": "agent",
      "member": "alpha",
      "installed_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
JSON
run uninstall evil --scope project >/tmp/codex-teams-evil-uninstall.out 2>/tmp/codex-teams-evil-uninstall.err
assert_not_exists "$OUTSIDE_MANIFEST_TARGET"
assert_grep /tmp/codex-teams-evil-uninstall.err "WARN"
pass "project uninstall skips out-of-root manifest paths"

SYMLINK_PROJECT="$TMP/symlink-project"
mkdir -p "$SYMLINK_PROJECT/.git" "$TMP/outside-codex" "$TMP/outside-state"
ln -s "$TMP/outside-codex" "$SYMLINK_PROJECT/.codex"
set +e
(cd "$SYMLINK_PROJECT" && run install "$PROJECT/team.json" --scope project --skip-model-check) >/tmp/codex-teams-symlink-install.out 2>&1
SYMLINK_INSTALL_STATUS=$?
set -e
if [[ "$SYMLINK_INSTALL_STATUS" -eq 0 ]]; then
  fail "project install followed .codex symlink"
fi
assert_not_exists "$TMP/outside-codex/agents/review-panel-security.toml"
rm "$SYMLINK_PROJECT/.codex"
ln -s "$TMP/outside-state" "$SYMLINK_PROJECT/.codex-teams"
set +e
(cd "$SYMLINK_PROJECT" && run state init review-panel --goal "verify goal") >/tmp/codex-teams-symlink-state.out 2>&1
SYMLINK_STATE_STATUS=$?
set -e
if [[ "$SYMLINK_STATE_STATUS" -eq 0 ]]; then
  fail "state init followed .codex-teams symlink"
fi
assert_not_exists "$TMP/outside-state/review-panel/state.json"
pass "project roots reject symlink escape"

[[ ! -d "$ROOT/src/kit" ]] || fail "src/kit still exists"
[[ ! -d "$ROOT/dist/kit" ]] || fail "dist/kit still exists"
"$NODE_BIN" -e 'const f=require("fs");const p=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(Object.keys(p.dependencies||{}).length!==0)process.exit(1)' "$ROOT/package.json" || fail "runtime dependencies are not empty"
"$NODE_BIN" --input-type=module -e 'const {pathToFileURL}=await import("node:url");const mod=await import(pathToFileURL(process.argv[1]).href);for(const key of ["installTeam","uninstallTeam","renderAgentToml","listInstalledTeams","resolveAgentsRoot","doctor","doctorIsHealthy","assembleLeaderPrompt","buildRunPlan","runTeam","nativeV1Harness","initState","addTask","claimTask","reopenTask","addNote","parseTeamJson","validateTeamDef"])if(!(key in mod))process.exit(1);for(const key of ["acquireMkdirLock","withLock","renderToml","tomlBasicString","buildCodexArgv"])if(key in mod)process.exit(1)' "$ROOT/dist/index.js" || fail "public exports do not match supported surface"
pass "kit code removed and public exports narrowed"

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
