#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
CLI="$ROOT/dist/cli.js"

pass() { printf 'PASS %s\n' "$1"; }
skip() { printf 'SKIP %s\n' "$1"; exit 0; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

if [[ -n "${CODEX_BIN:-}" ]]; then
  [[ -x "$CODEX_BIN" ]] || fail "CODEX_BIN is not executable: $CODEX_BIN"
else
  CODEX_BIN="$(command -v codex || true)"
fi
[[ -n "$CODEX_BIN" ]] || skip "codex binary not found"
[[ -f "$CLI" && -f "$ROOT/dist/index.js" ]] || fail "build first: missing dist/cli.js or dist/index.js"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-claude-provider-behavioral.XXXXXX")"
# macOS: TMPDIR가 슬래시로 끝나 이중 슬래시가 생기고, /var는 /private/var의
# symlink라 pwd 출력과 문자열 비교가 어긋난다. 물리 경로로 정규화한다.
TMP="$(cd "$TMP" && pwd -P)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

export HOME="$TMP/home"
export CODEX_HOME="$TMP/codex-home"
WORKSPACE="$TMP/workspace"
mkdir -p "$HOME/.codex" "$HOME/.claude" "$CODEX_HOME" "$WORKSPACE"

CODEX_EXEC_SANDBOX="${CODEX_EXEC_SANDBOX:-}"
if [[ -z "$CODEX_EXEC_SANDBOX" ]]; then
  CODEX_EXEC_SANDBOX="read-only"
  # GitHub-hosted Linux runners do not allow the bwrap loopback setup Codex
  # uses for read-only/workspace-write sandboxes. This check still runs in a
  # throwaway HOME, CODEX_HOME, and workspace, so keep local verification
  # stricter while using an unsandboxed Codex child only in Actions.
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    CODEX_EXEC_SANDBOX="danger-full-access"
  fi
fi
case "$CODEX_EXEC_SANDBOX" in
  read-only|workspace-write|danger-full-access) ;;
  *) fail "unsupported CODEX_EXEC_SANDBOX: $CODEX_EXEC_SANDBOX" ;;
esac

TRACE="$TMP/fake-trace.jsonl"
SERVER_OUT="$TMP/fake-server.out"
SERVER_ERR="$TMP/fake-server.err"
FAKE_CLAUDE_TRACE="$TRACE" "$NODE_BIN" "$ROOT/verify/fake-server.mjs" >"$SERVER_OUT" 2>"$SERVER_ERR" &
SERVER_PID=$!

BASE_URL=""
for _ in $(seq 1 80); do
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    cat "$SERVER_ERR" >&2 || true
    fail "fake server exited before startup"
  fi
  if [[ -s "$SERVER_OUT" ]]; then
    BASE_URL="$("$NODE_BIN" -e 'const fs=require("fs");const line=fs.readFileSync(process.argv[1],"utf8").trim().split(/\n/)[0];process.stdout.write(JSON.parse(line).baseUrl)' "$SERVER_OUT")"
    break
  fi
  sleep 0.1
done
[[ -n "$BASE_URL" ]] || fail "fake server did not print baseUrl"
pass "fake backend server started"

"$NODE_BIN" "$CLI" install \
  --codex-home "$CODEX_HOME" \
  --base-url "$BASE_URL" \
  --provider-id claude_provider \
  --model claude-provider \
  --set-default >/tmp/codex-claude-provider-install.out
pass "provider installed into sandbox CODEX_HOME"

CODEX_STDOUT="$TMP/codex.stdout"
CODEX_STDERR="$TMP/codex.stderr"
set +e
"$NODE_BIN" --input-type=module - "$CODEX_BIN" "$WORKSPACE" "$CODEX_STDOUT" "$CODEX_STDERR" "$CODEX_EXEC_SANDBOX" <<'NODE'
import { spawn } from "node:child_process";

const [, , codexBin, workspace, stdoutPath, stderrPath, sandbox] = process.argv;
const fs = await import("node:fs");
const args = [
  "exec",
  "--cd",
  workspace,
  "--sandbox",
  sandbox,
  "--skip-git-repo-check",
  "-m",
  "claude-provider",
  "Use exec_command to run pwd, then reply with only the command output path."
];

const child = spawn(codexBin, args, {
  env: {
    ...process.env,
    OPENAI_API_KEY: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, `${stderr}\nTIMEOUT\n`);
  process.exit(124);
}, 120_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  process.exit(code ?? 1);
});
NODE
CODEX_STATUS=$?
set -e
if [[ "$CODEX_STATUS" -ne 0 ]]; then
  cat "$CODEX_STDERR" >&2 || true
  fail "codex exec exited $CODEX_STATUS"
fi
pass "codex exec custom provider roundtrip exited 0"

"$NODE_BIN" --input-type=module - "$TRACE" "$WORKSPACE" "$CODEX_STDOUT" <<'NODE'
import fs from "node:fs";

const [, , tracePath, workspace, stdoutPath] = process.argv;
const events = fs.readFileSync(tracePath, "utf8")
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requests = events.filter((event) => event.type === "adapter_request" && event.path === "/v1/responses");
assert(requests.length >= 2, `expected at least 2 adapter requests, got ${requests.length}`);

const secondInput = requests[1].body?.input;
assert(Array.isArray(secondInput), "second request input is not an array");
const tailTypes = secondInput.slice(-4).map((item) => item?.type);
assert(tailTypes.includes("function_call"), `second request tail lacks function_call: ${tailTypes.join(",")}`);
assert(tailTypes.includes("function_call_output"), `second request tail lacks function_call_output: ${tailTypes.join(",")}`);

const ids = requests.map((request) => ({
  session: request.headers?.["session-id"],
  thread: request.headers?.["thread-id"],
  prompt: request.body?.prompt_cache_key
}));
const stable = ids.every((id) => id.session && id.session === ids[0].session)
  && ids.every((id) => id.thread && id.thread === ids[0].thread)
  && ids.every((id) => id.prompt && id.prompt === ids[0].prompt);
if (stable) {
  fs.appendFileSync(tracePath, `${JSON.stringify({ type: "codex_ids_stable", ids: ids[0] })}\n`);
}

const stdout = fs.readFileSync(stdoutPath, "utf8").replace(/\r/g, "").trim();
assert(stdout.includes(workspace), `stdout does not contain workspace path; stdout=${JSON.stringify(stdout)}`);
// fake backend는 tool output(Codex exec_command의 Chunk 래퍼 포함)을 최종
// 텍스트로 그대로 반환하므로 "workspace 경로만 출력" 단언은 성립하지 않는다.
// 마지막 비어있지 않은 라인이 workspace 경로인지로 판정한다.
const lastLine = stdout.split("\n").filter((line) => line.trim() !== "").pop() ?? "";
assert(lastLine.trim() === workspace, `stdout last line is not the workspace path: ${JSON.stringify(lastLine)}`);
NODE
pass "Codex sent function_call_output tail and returned workspace path"

"$NODE_BIN" "$CLI" uninstall \
  --codex-home "$CODEX_HOME" \
  --provider-id claude_provider >/tmp/codex-claude-provider-uninstall.out

if [[ -f "$CODEX_HOME/config.toml" ]] && grep -E '^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"claude_provider"|^[[:space:]]*model[[:space:]]*=[[:space:]]*"claude-provider"|^[[:space:]]*\[model_providers\.claude_provider\]|^# (BEGIN|END) codex-modules claude-provider' "$CODEX_HOME/config.toml" >/dev/null; then
  fail "uninstall left claude provider config in config.toml"
fi
pass "uninstall removes provider config from sandbox config"
