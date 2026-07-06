#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"
CODEX_HOME_SANDBOX="$SANDBOX/codex-home"
STATE="$SANDBOX/state"
OUT="$SANDBOX/out"

cleanup() {
  rm -rf "$SANDBOX"
}
trap cleanup EXIT

fail() {
  echo "FAIL $*" >&2
  exit 1
}

pass() {
  echo "PASS $*"
}

mkdir -p "$CODEX_HOME_SANDBOX/sessions/2026/07/06" "$CODEX_HOME_SANDBOX/archived_sessions" "$STATE" "$OUT"

MAIN="$CODEX_HOME_SANDBOX/sessions/2026/07/06/rollout-2026-07-06T01-00-00.000Z-s-main.jsonl"
CHILD="$CODEX_HOME_SANDBOX/sessions/2026/07/06/rollout-2026-07-06T01-30-00.000Z-s-child.jsonl"
ARCHIVED="$CODEX_HOME_SANDBOX/archived_sessions/rollout-2026-07-05T23-00-00.000Z-s-archived.jsonl"

cat > "$MAIN" <<'JSONL'
{"type":"session_meta","payload":{"session_id":"s-main","id":"s-main","cwd":"/tmp/project-a","originator":"Codex Desktop","cli_version":"0.142.5"}}
{"type":"event_msg","payload":{"type":"user_message","message":"Design a local SQLite FTS5 recall module."}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"We will index Codex rollout JSONL into SQLite FTS5."}]}}
{"type":"response_item","payload":{"type":"function_call","name":"Bash","call_id":"call-1","arguments":"{\"command\":\"rg FTS5 docs\"}"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"FTS5 supports MATCH and snippet()."}}
{"type":"event_msg","payload":{"type":"token_count","input_tokens":123456,"output_tokens":789}}
{"type":"event_msg","payload":{"type":"agent_message","message":"The verify script should not index token_count noise."}}
{"type":"event_msg","payload":{"type":"user_message","message":"Filler turn one about unrelated refactoring work."}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Filler reply one describing the refactoring plan."}}
{"type":"event_msg","payload":{"type":"user_message","message":"Filler turn two about documentation cleanup."}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Filler reply two describing the documentation pass."}}
{"type":"event_msg","payload":{"type":"user_message","message":"Filler turn three about the release checklist."}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Filler reply three wrapping up the release checklist."}}
JSONL

cat > "$CHILD" <<'JSONL'
{"type":"session_meta","payload":{"session_id":"s-child","id":"s-child","parent_thread_id":"s-main","cwd":"/tmp/project-a","originator":"Codex Desktop","source":{"subagent":{"thread_spawn":{"parent_thread_id":"s-main","depth":1,"agent_nickname":"researcher"}}}}}
{"type":"event_msg","payload":{"type":"user_message","message":"Subagent duplicate FTS5 note."}}
{"type":"event_msg","payload":{"type":"agent_message","message":"This should not outrank the interactive session by default."}}
JSONL

cat > "$ARCHIVED" <<'JSONL'
{"type":"session_meta","payload":{"session_id":"s-archived","id":"s-archived","cwd":"/tmp/project-b","originator":"Codex CLI"}}
{"type":"event_msg","payload":{"type":"user_message","message":"Archived-only zeta-memory probe."}}
{"type":"event_msg","payload":{"type":"agent_message","message":"The archive result is opt-in."}}
JSONL

cat > "$CODEX_HOME_SANDBOX/session_index.jsonl" <<'JSONL'
{"id":"s-main","thread_name":"session recall design","updated_at":"2026-07-06T01:10:00.000Z"}
JSONL

cat > "$CODEX_HOME_SANDBOX/history.jsonl" <<'JSONL'
{"session_id":"s-child","ts":"2026-07-06T01:30:00.000Z","text":"child fallback title"}
JSONL

find "$CODEX_HOME_SANDBOX" -type f -exec shasum -a 256 {} \; | sort > "$OUT/codex-home.before"

cd "$ROOT"
npm run build >/dev/null
pass "build"

node --input-type=module - <<'NODE'
import Database from "better-sqlite3";
const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE probe USING fts5(content)");
db.close();
NODE
pass "fts5 probe"

node dist/cli.js sync --codex-home "$CODEX_HOME_SANDBOX" --state-dir "$STATE" --json > "$OUT/sync1.json"
node --input-type=module - "$OUT/sync1.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!data.success) throw new Error("sync failed");
if (data.files.indexed !== 2) throw new Error(`expected 2 indexed files, got ${data.files.indexed}`);
if (data.sessions.inserted !== 2) throw new Error(`expected 2 inserted sessions, got ${data.sessions.inserted}`);
if (data.messages.inserted !== 13) throw new Error(`expected 13 inserted messages, got ${data.messages.inserted}`);
if ("dbPath" in data) throw new Error("dbPath leaked without --debug-paths");
NODE
pass "initial sync"

node dist/cli.js search "SQLite FTS5" --state-dir "$STATE" --json > "$OUT/search.json"
node --input-type=module - "$OUT/search.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.count < 1) throw new Error("expected at least one search result");
const first = data.results[0];
if (first.session_id !== "s-main") throw new Error(`expected s-main first, got ${first.session_id}`);
if (first.lineage_root_id !== "s-main") throw new Error(`expected lineage root s-main, got ${first.lineage_root_id}`);
if (!Number.isInteger(first.match_message_ref)) throw new Error("missing integer match_message_ref");
if (!first.messages.some((message) => message.anchor)) throw new Error("missing anchor message");
if ((first.bookend_start.length + first.bookend_end.length) < 1) throw new Error("missing bookend prose");
if ("rollout_path" in first) throw new Error("rollout path leaked without --debug-paths");
NODE
pass "search with lineage dedupe"

node dist/cli.js search "123456" --state-dir "$STATE" --json > "$OUT/noise.json"
node --input-type=module - "$OUT/noise.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.count !== 0) throw new Error(`expected token_count noise to be excluded, got ${data.count}`);
NODE
pass "noise exclusion"

MATCH_REF="$(node --input-type=module - "$OUT/search.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(String(data.results[0].match_message_ref));
NODE
)"

node dist/cli.js around s-main "$MATCH_REF" --state-dir "$STATE" --json > "$OUT/around.json"
node --input-type=module - "$OUT/around.json" "$MATCH_REF" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ref = Number(process.argv[3]);
if (!data.messages.some((message) => message.seq === ref)) throw new Error("around result missed anchor ref");
if (!Number.isInteger(data.messages_before) || !Number.isInteger(data.messages_after)) throw new Error("around counts are not numeric");
NODE
pass "around"

node dist/cli.js read s-main --state-dir "$STATE" --json > "$OUT/read.json"
node --input-type=module - "$OUT/read.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!data.messages.some((message) => message.role === "function")) throw new Error("read missed function call role");
if (!data.messages.some((message) => message.role === "tool")) throw new Error("read missed function output role");
NODE
pass "read"

node dist/cli.js sync --codex-home "$CODEX_HOME_SANDBOX" --state-dir "$STATE" --json > "$OUT/sync2.json"
node --input-type=module - "$OUT/sync2.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.files.indexed !== 0 || data.files.updated !== 0) throw new Error("unchanged sync indexed or updated files");
if (data.files.unchanged !== 2) throw new Error(`expected 2 unchanged files, got ${data.files.unchanged}`);
NODE
pass "incremental unchanged"

sleep 1
printf '%s\n' '{"type":"event_msg","payload":{"type":"agent_message","message":"Appended unique theta-memory term."}}' >> "$MAIN"
find "$CODEX_HOME_SANDBOX" -type f -exec shasum -a 256 {} \; | sort > "$OUT/codex-home.before"
node dist/cli.js sync --codex-home "$CODEX_HOME_SANDBOX" --state-dir "$STATE" --json > "$OUT/sync3.json"
node --input-type=module - "$OUT/sync3.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.files.updated !== 1) throw new Error(`expected 1 updated file, got ${data.files.updated}`);
NODE
node dist/cli.js search "theta-memory" --state-dir "$STATE" --json > "$OUT/search-changed.json"
node --input-type=module - "$OUT/search-changed.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.count !== 1 || data.results[0].session_id !== "s-main") throw new Error("changed term did not return s-main");
NODE
pass "incremental changed"

node dist/cli.js search "zeta-memory" --state-dir "$STATE" --json > "$OUT/search-archived-before.json"
node --input-type=module - "$OUT/search-archived-before.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.count !== 0) throw new Error("archived result appeared before include-archived sync");
NODE
node dist/cli.js sync --codex-home "$CODEX_HOME_SANDBOX" --state-dir "$STATE" --include-archived --json > "$OUT/sync-archived.json"
node dist/cli.js search "zeta-memory" --state-dir "$STATE" --json > "$OUT/search-archived-after.json"
node --input-type=module - "$OUT/search-archived-after.json" <<'NODE'
import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.count !== 1 || data.results[0].session_id !== "s-archived") throw new Error("archived opt-in search failed");
NODE
pass "archived opt-in"

find "$CODEX_HOME_SANDBOX" -type f -exec shasum -a 256 {} \; | sort > "$OUT/codex-home.after"
if ! diff -u "$OUT/codex-home.before" "$OUT/codex-home.after" >/dev/null; then
  fail "CODEX_HOME files changed during CLI operations"
fi
if [[ "$STATE" != "$SANDBOX"/state ]]; then
  fail "state directory escaped sandbox"
fi
if [[ ! -f "$STATE/state.sqlite" ]]; then
  fail "state database missing"
fi
if find "$CODEX_HOME_SANDBOX" -name 'state.sqlite' -print -quit | grep -q .; then
  fail "state database was created under CODEX_HOME"
fi
pass "sandbox state isolation"

echo "PASS session-recall verify"
