#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
CLI="$ROOT/dist/cli.js"
INDEX="$ROOT/dist/index.js"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ -f "$INDEX" && -f "$CLI" ]] || fail "build first: missing dist/index.js or dist/cli.js"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-claude-provider-verify.XXXXXX")"
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
mkdir -p "$HOME/.codex" "$HOME/.claude" "$CODEX_HOME"

"$NODE_BIN" --input-type=module - "$ROOT" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const lockPath = path.join(root, "package-lock.json");
if (!fs.existsSync(lockPath)) {
  throw new Error("missing package-lock.json");
}
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const required = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "zod"
];

for (const name of required) {
  const installedPath = path.join(root, "node_modules", name, "package.json");
  if (!fs.existsSync(installedPath)) {
    throw new Error(`missing installed dependency ${name}`);
  }
  const installed = JSON.parse(fs.readFileSync(installedPath, "utf8")).version;
  const locked =
    lock.packages?.[`node_modules/${name}`]?.version ??
    lock.dependencies?.[name]?.version;
  if (!locked) {
    throw new Error(`missing lockfile entry for ${name}`);
  }
  if (installed !== locked) {
    throw new Error(`${name} version mismatch: installed ${installed}, lockfile ${locked}`);
  }
}
NODE
pass "dependencies match package-lock versions"

expect_cli_fail() {
  local label="$1"
  shift
  "$NODE_BIN" --input-type=module - "$label" "$@" <<'NODE'
import { spawn } from "node:child_process";

const [, , label, command, ...args] = process.argv;
const child = spawn(command, args, {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  console.error(`${label} unexpectedly kept running`);
  console.error(stdout);
  console.error(stderr);
  process.exit(1);
}, 4000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code === 0) {
    console.error(`${label} unexpectedly exited 0`);
    console.error(stdout);
    console.error(stderr);
    process.exit(1);
  }
  process.exit(0);
});
NODE
}

expect_cli_fail "non-local bind is rejected" "$NODE_BIN" "$CLI" serve --host 0.0.0.0 --port 0 --json
pass "non-local bind is rejected"

ANTHROPIC_API_KEY="synthetic-shadow-key" expect_cli_fail "ANTHROPIC_API_KEY blocks serve" "$NODE_BIN" "$CLI" serve --host 127.0.0.1 --port 0 --json
pass "ANTHROPIC_API_KEY without allow flag blocks serve"

ANTHROPIC_API_KEY="synthetic-shadow-key" expect_cli_fail "ANTHROPIC_API_KEY blocks doctor" "$NODE_BIN" "$CLI" doctor --codex-home "$CODEX_HOME" --json
pass "ANTHROPIC_API_KEY without allow flag blocks doctor"

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

"$NODE_BIN" --input-type=module - "$ROOT" "$BASE_URL" "$TRACE" "$SERVER_ERR" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const baseUrl = process.argv[3];
const tracePath = process.argv[4];
const serverErrPath = process.argv[5];
const fixtures = path.join(root, "verify", "fixtures");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function request(pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text
  };
}

async function postSse(body, headers = {}) {
  const response = await request("/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "text/event-stream",
      "session-id": "synthetic-session",
      "thread-id": "synthetic-thread",
      "x-client-request-id": "synthetic-request",
      ...headers
    },
    body
  });
  assert(response.status === 200, `expected SSE 200, got ${response.status}: ${response.text}`);
  assert(/text\/event-stream/.test(response.headers["content-type"] ?? ""), "missing event-stream content-type");
  return parseSse(response.text);
}

function parseSse(text) {
  const blocks = text.split(/\r?\n\r?\n/).filter(Boolean);
  const events = [];
  let doneCount = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = "";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") {
      doneCount += 1;
      events.push({ event: "done", done: true });
      continue;
    }
    const data = JSON.parse(dataText);
    events.push({ event: eventName || data.type, data });
  }
  return { events, doneCount, raw: text };
}

function jsonEvents(parsed) {
  return parsed.events.filter((event) => !event.done);
}

function eventType(frame) {
  return frame.event || frame.data?.type;
}

function responseIdFrom(data) {
  return data?.response?.id ?? data?.response_id ?? data?.id;
}

function outputItemFrom(data) {
  return data?.item ?? data?.output_item ?? data?.response?.output?.[0] ?? data?.output?.[0];
}

function usageFrom(data) {
  return data?.response?.usage ?? data?.usage;
}

function extractFunctionCall(parsed) {
  let found = null;
  for (const frame of jsonEvents(parsed)) {
    const item = outputItemFrom(frame.data);
    if (item?.type === "function_call" || item?.call_id || item?.callId) {
      found = {
        name: item.name ?? item.toolName,
        callId: item.call_id ?? item.callId ?? item.id,
        itemId: item.id,
        argumentsText: item.arguments ?? item.arguments_delta ?? item.args
      };
      break;
    }
  }
  if (!found) return null;
  const done = jsonEvents(parsed).find((frame) => eventType(frame) === "response.function_call_arguments.done");
  const delta = jsonEvents(parsed).find((frame) => eventType(frame) === "response.function_call_arguments.delta");
  found.argumentsText = done?.data?.arguments ?? found.argumentsText ?? delta?.data?.delta;
  found.itemId = found.itemId ?? done?.data?.item_id ?? delta?.data?.item_id;
  return found;
}

function extractText(parsed) {
  const parts = [];
  for (const frame of jsonEvents(parsed)) {
    const data = frame.data;
    if (typeof data?.delta === "string") parts.push(data.delta);
    if (typeof data?.text === "string" && eventType(frame) === "response.output_text.done") parts.push(data.text);
    const output = data?.response?.output ?? [];
    for (const item of output) {
      for (const content of item.content ?? []) {
        if (typeof content.text === "string") parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function assertDoneOnce(parsed, label) {
  assert(parsed.doneCount === 1, `${label}: expected exactly one [DONE], got ${parsed.doneCount}`);
}

function assertUsage(parsed, label) {
  const completed = jsonEvents(parsed).find((frame) => eventType(frame) === "response.completed");
  assert(completed, `${label}: missing response.completed`);
  const usage = usageFrom(completed.data);
  assert(usage && Number.isFinite(usage.input_tokens), `${label}: missing usage.input_tokens`);
  assert(Number.isFinite(usage.output_tokens), `${label}: missing usage.output_tokens`);
  assert(Number.isFinite(usage.total_tokens), `${label}: missing usage.total_tokens`);
}

function assertFunctionCallSse(parsed, label) {
  assertDoneOnce(parsed, label);
  const frames = jsonEvents(parsed);
  assert(eventType(frames[0]) === "response.created", `${label}: response.created is not first`);

  const responseIds = frames.map((frame) => responseIdFrom(frame.data)).filter(Boolean);
  assert(responseIds.length > 0, `${label}: missing response id fields`);
  assert(new Set(responseIds).size === 1, `${label}: inconsistent response ids`);

  const added = frames.find((frame) => eventType(frame) === "response.output_item.added");
  const argDelta = frames.find((frame) => eventType(frame) === "response.function_call_arguments.delta");
  const argDone = frames.find((frame) => eventType(frame) === "response.function_call_arguments.done");
  const itemDone = frames.find((frame) => eventType(frame) === "response.output_item.done");
  assert(added && argDelta && argDone && itemDone, `${label}: missing function_call event frames`);

  const call = extractFunctionCall(parsed);
  assert(call, `${label}: missing function_call item`);
  assert(call.name === "exec_command", `${label}: unexpected function_call.name ${call.name}`);
  assert(call.callId, `${label}: missing call_id`);

  const itemIds = [added, itemDone].map((frame) => outputItemFrom(frame.data)?.id).filter(Boolean);
  assert(itemIds.length >= 1, `${label}: missing item id`);
  assert(new Set(itemIds).size === 1, `${label}: inconsistent item ids`);

  for (const frame of [argDelta, argDone]) {
    assert(frame.data.output_index === 0, `${label}: expected output_index 0`);
    assert((frame.data.item_id ?? call.itemId), `${label}: missing item_id on arguments frame`);
  }

  const argsText = typeof call.argumentsText === "string"
    ? call.argumentsText
    : JSON.stringify(call.argumentsText);
  assert(typeof argsText === "string", `${label}: arguments is not a string`);
  JSON.parse(argsText);
  assertUsage(parsed, label);
  return call;
}

function assertTextSse(parsed, label) {
  assertDoneOnce(parsed, label);
  const frames = jsonEvents(parsed);
  assert(eventType(frames[0]) === "response.created", `${label}: response.created is not first`);
  assert(frames.some((frame) => eventType(frame) === "response.output_text.done"), `${label}: missing output_text.done`);
  const completed = frames.find((frame) => eventType(frame) === "response.completed");
  assert(completed, `${label}: missing response.completed`);
  const output = completed.data?.response?.output;
  assert(Array.isArray(output), `${label}: completed response.output is not an array`);
  assert(output.some((item) => item.type === "message"), `${label}: final output lacks message item`);
  assertUsage(parsed, label);
}

function traceEvents() {
  if (!fs.existsSync(tracePath)) return [];
  return fs.readFileSync(tracePath, "utf8")
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function backendStartCount() {
  return traceEvents().filter((event) => event.type === "backend_start_query").length;
}

function makeOutputTurn(base, callId, output) {
  const next = clone(base);
  next.input = [
    ...next.input,
    {
      type: "function_call",
      name: "exec_command",
      call_id: callId,
      arguments: "{\"cmd\":\"pwd\"}"
    },
    {
      type: "function_call_output",
      call_id: callId,
      output
    }
  ];
  return next;
}

const health = await request("/healthz");
assert(health.status === 200, `/healthz status ${health.status}`);
assert(JSON.parse(health.text).ok === true, "/healthz did not return ok true");

const origin = await request("/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "accept": "text/event-stream",
    "origin": "https://example.invalid"
  },
  body: { stream: true }
});
assert(origin.status === 403, `Origin request expected 403, got ${origin.status}`);

const secFetch = await request("/responses", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "accept": "text/event-stream",
    "sec-fetch-site": "cross-site"
  },
  body: { stream: true }
});
assert(secFetch.status === 403, `Sec-Fetch-Site request expected 403, got ${secFetch.status}`);

const nonJson = await request("/responses", {
  method: "POST",
  headers: {
    "content-type": "text/plain",
    "accept": "text/event-stream"
  },
  body: "{}"
});
assert(nonJson.status >= 400, `non-json request expected failure, got ${nonJson.status}`);

const options = await request("/responses", { method: "OPTIONS" });
assert(options.status === 403, `OPTIONS expected 403, got ${options.status}`);

const firstBody = readFixture("message-only-turn.json");
const firstHeaders = {
  "session-id": "synthetic-session-main",
  "thread-id": "synthetic-thread-main",
  "x-client-request-id": "synthetic-retry-key"
};
const first = await postSse(firstBody, firstHeaders);
const firstCall = assertFunctionCallSse(first, "first tool call");
const startCountAfterFirst = backendStartCount();

const duplicate = await postSse(firstBody, firstHeaders);
const duplicateCall = assertFunctionCallSse(duplicate, "duplicate replay");
assert(duplicateCall.callId === firstCall.callId, "duplicate replay did not preserve call_id");
assert(backendStartCount() === startCountAfterFirst, "duplicate replay created a new Claude query");

const outputBody = readFixture("function-call-output-turn.json");
const outputText = JSON.stringify(outputBody).replaceAll("__CALL_ID__", firstCall.callId);
const output = await postSse(JSON.parse(outputText), {
  "session-id": "synthetic-session-main",
  "thread-id": "synthetic-thread-main",
  "x-client-request-id": "synthetic-tool-output"
});
assertTextSse(output, "final tool output");
assert(extractText(output).includes("/tmp/codex-claude-provider-offline"), "final text did not include tool output");

const multiBody = readFixture("message-only-turn.json");
multiBody.input[0].content[0].text = "[[fake:multi-tool]] Run two synthetic tools in sequence.";
multiBody.prompt_cache_key = "synthetic-session-multi";
const multiHeaders = {
  "session-id": "synthetic-session-multi",
  "thread-id": "synthetic-thread-multi",
  "x-client-request-id": "synthetic-multi-first"
};
const multiFirst = await postSse(multiBody, multiHeaders);
const multiFirstCall = assertFunctionCallSse(multiFirst, "multi first call");
const multiSecond = await postSse(makeOutputTurn(multiBody, multiFirstCall.callId, "first-output"), {
  ...multiHeaders,
  "x-client-request-id": "synthetic-multi-second"
});
const multiSecondCall = assertFunctionCallSse(multiSecond, "multi drain second call");
assert(multiSecondCall.callId !== multiFirstCall.callId, "multi drain reused the first call_id");
const multiFinal = await postSse(makeOutputTurn(makeOutputTurn(multiBody, multiFirstCall.callId, "first-output"), multiSecondCall.callId, "second-output"), {
  ...multiHeaders,
  "x-client-request-id": "synthetic-multi-final"
});
assertTextSse(multiFinal, "multi final result");

const unsupported = await postSse(readFixture("unsupported-schema-tool-turn.json"), {
  "session-id": "synthetic-session-unsupported",
  "thread-id": "synthetic-thread-unsupported",
  "x-client-request-id": "synthetic-unsupported"
});
assertTextSse(unsupported, "unsupported schema final");

const namespace = await postSse(readFixture("namespace-web-search-turn.json"), {
  "session-id": "synthetic-session-namespace",
  "thread-id": "synthetic-thread-namespace",
  "x-client-request-id": "synthetic-namespace"
});
assertTextSse(namespace, "namespace web_search final");

const starts = traceEvents().filter((event) => event.type === "backend_start_query");
const leakedNames = starts.flatMap((event) => event.toolNames ?? [])
  .filter((name) => ["unsupported_recursive", "web_search", "open", "web"].includes(name));
assert(leakedNames.length === 0, `non-Codex or unsupported tools reached Claude catalog: ${leakedNames.join(", ")}`);

const fixtureText = fs.readdirSync(fixtures)
  .filter((name) => name.endsWith(".json"))
  .map((name) => fs.readFileSync(path.join(fixtures, name), "utf8"))
  .join("\n");
assert(!/\bthinking\b|signature|raw Claude/i.test(fixtureText), "fixtures contain raw Claude/thinking-like fields");

const stderr = fs.existsSync(serverErrPath) ? fs.readFileSync(serverErrPath, "utf8") : "";
assert(!stderr.includes("[[fake:"), "default logs contain request body preview");
assert(!stderr.includes("/tmp/codex-claude-provider-offline"), "default logs contain tool output preview");
NODE
pass "offline Responses SSE, replay, drain, fixtures, and security assertions passed"
