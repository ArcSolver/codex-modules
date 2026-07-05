#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-subagents-verify.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$ROOT"

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

npm --prefix "$ROOT" run build >/dev/null

FAKE_BIN_DIR="$WORK_DIR/bin"
mkdir -p "$FAKE_BIN_DIR"
FAKE_CODEX="$FAKE_BIN_DIR/codex"
cat >"$FAKE_CODEX" <<'SHIM'
#!/usr/bin/env node
const { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
const stateDir = process.env.FAKE_CODEX_STATE;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withLock(fn) {
  const lock = join(stateDir, "lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function updateActive(delta) {
  if (!stateDir) return { active: 0, maxActive: 0 };
  mkdirSync(stateDir, { recursive: true });
  return withLock(() => {
    const file = join(stateDir, "active.json");
    const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { active: 0, maxActive: 0 };
    current.active += delta;
    current.maxActive = Math.max(current.maxActive, current.active);
    writeFileSync(file, JSON.stringify(current));
    return current;
  });
}

function outputPath() {
  const index = args.indexOf("-o");
  return index === -1 ? null : args[index + 1];
}

function promptArg() {
  return args[args.length - 1] ?? "";
}

function stdinIsDevNull() {
  try {
    const stdin = fstatSync(0);
    const devNull = statSync("/dev/null");
    return stdin.rdev === devNull.rdev;
  } catch {
    return false;
  }
}

if (args[0] === "--version") {
  console.log("codex-cli 0.139.0");
  process.exit(0);
}

if (args[0] === "features" && args[1] === "list") {
  console.log("child_agents_md                      under development  false");
  console.log("enable_fanout                        under development  false");
  console.log("multi_agent                          stable             true");
  console.log("multi_agent_v2                       under development  false");
  process.exit(0);
}

const out = outputPath();
const prompt = promptArg();
appendFileSync(logPath, `${JSON.stringify({ args, stdinIsDevNull: stdinIsDevNull(), out, prompt, event: "start", ts: Date.now() })}\n`);
updateActive(1);

process.on("SIGTERM", () => {
  appendFileSync(logPath, `${JSON.stringify({ args, event: "term", ts: Date.now() })}\n`);
  updateActive(-1);
  process.exit(143);
});

if (prompt.includes("STALL")) {
  setInterval(() => {}, 1000);
} else if (prompt.includes("SLOW")) {
  mainSlow();
} else {
  mainOk();
}

async function mainSlow() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    console.log(JSON.stringify({ type: "heartbeat", ts: Date.now() }));
    await sleep(200);
  }
}

async function mainOk() {
  await sleep(300);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `done ${prompt}\n`);
  }
  console.log(JSON.stringify({ type: "message", prompt }));
  appendFileSync(logPath, `${JSON.stringify({ args, event: "end", ts: Date.now() })}\n`);
  updateActive(-1);
}
SHIM
chmod +x "$FAKE_CODEX"

CODEX_BIN="$FAKE_CODEX" WORK_DIR="$WORK_DIR" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildArgv, detectNative, doctor, runTasks } from "./dist/index.js";

const root = process.env.WORK_DIR;
const bin = process.env.CODEX_BIN;
const logPath = join(root, "fake-argv.jsonl");
const stateDir = join(root, "state");
process.env.FAKE_CODEX_LOG = logPath;
process.env.FAKE_CODEX_STATE = stateDir;

const unitOut = join(root, "unit-out");
const argv = buildArgv(
  {
    id: "unit",
    prompt: "hello",
    cwd: "/tmp/work",
    sandbox: "workspace-write",
    model: "gpt-test",
    effort: "high",
    outputSchemaPath: "schema.json",
    configOverrides: { "agents.max_depth": "1" },
  },
  { outDir: unitOut, ephemeral: true },
);
assert.deepEqual(argv, [
  "exec",
  "--skip-git-repo-check",
  "-C",
  "/tmp/work",
  "-s",
  "workspace-write",
  "-m",
  "gpt-test",
  "-c",
  "model_reasoning_effort=high",
  "-c",
  "agents.max_depth=1",
  "--output-schema",
  "schema.json",
  "-o",
  join(unitOut, "unit.md"),
  "--json",
  "--ephemeral",
  "hello",
]);
assert.throws(() => buildArgv({ id: "bad", prompt: "x", configOverrides: { "features.bypass_safety": "true" } }, { outDir: unitOut, ephemeral: true }));
assert.throws(() => buildArgv({ id: "bad2", prompt: "x", configOverrides: { sandbox_mode: "danger-full-access" } }, { outDir: unitOut, ephemeral: true }));
assert.throws(() => buildArgv({ id: "../bad", prompt: "x" }, { outDir: unitOut, ephemeral: true }));

const native = detectNative({ bin });
assert.equal(native.features.find(feature => feature.name === "multi_agent")?.usable, true);
assert.equal(native.features.find(feature => feature.name === "enable_fanout")?.usable, false);
assert.ok(doctor({ bin }).recommendations.some(item => item.includes("exec runner")));

const outDir = join(root, "out");
const tasks = [
  { id: "a", prompt: "OK a", sandbox: "read-only" },
  { id: "b", prompt: "OK b", sandbox: "read-only" },
  { id: "c", prompt: "OK c", sandbox: "read-only" },
];
const results = await runTasks(tasks, { outDir, parallel: 2, timeoutSec: 10, stallSec: 5, bin });
assert.deepEqual(results.map(result => result.status), ["ok", "ok", "ok"]);
for (const task of tasks) {
  assert.ok(existsSync(join(outDir, `${task.id}.md`)), `${task.id} output exists`);
  assert.ok(existsSync(join(outDir, `${task.id}.events.jsonl`)), `${task.id} events exists`);
}

const records = readFileSync(logPath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const starts = records.filter(record => record.event === "start");
assert.equal(starts.length, 3);
assert.ok(starts.every(record => record.stdinIsDevNull === true), "stdin should be /dev/null");
const startA = starts.find(record => record.prompt === "OK a");
assert.ok(startA, "start record for task a exists");
assert.deepEqual(startA.args, [
  "exec",
  "--skip-git-repo-check",
  "-s",
  "read-only",
  "-o",
  join(outDir, "a.md"),
  "--json",
  "--ephemeral",
  "OK a",
]);
const active = JSON.parse(readFileSync(join(stateDir, "active.json"), "utf8"));
assert.equal(active.maxActive, 2, "parallel cap should allow exactly two simultaneous workers");

const stallResults = await runTasks([{ id: "stall", prompt: "STALL", sandbox: "read-only" }], {
  outDir: join(root, "stall-out"),
  parallel: 1,
  timeoutSec: 10,
  stallSec: 1,
  bin,
});
assert.equal(stallResults[0].status, "stall");

const timeoutResults = await runTasks([{ id: "timeout", prompt: "SLOW", sandbox: "read-only" }], {
  outDir: join(root, "timeout-out"),
  parallel: 1,
  timeoutSec: 1,
  stallSec: 5,
  bin,
});
assert.equal(timeoutResults[0].status, "timeout");

const resumeDir = join(root, "resume-out");
mkdirSync(resumeDir, { recursive: true });
writeFileSync(join(resumeDir, "done.md"), "already\n");
writeFileSync(logPath, "");
const resumeResults = await runTasks([{ id: "done", prompt: "OK should-not-run", sandbox: "read-only" }], {
  outDir: resumeDir,
  parallel: 1,
  timeoutSec: 10,
  stallSec: 1,
  bin,
  resume: true,
});
assert.equal(resumeResults[0].status, "ok");
assert.equal(readFileSync(logPath, "utf8"), "");
NODE
pass "fake codex verifies argv, dev-null stdin, parallel cap, stall, timeout, resume, and native diagnostics"

TASKS="$WORK_DIR/tasks.jsonl"
CLI_OUT="$WORK_DIR/cli-out"
printf '{"id":"cli","prompt":"OK cli","sandbox":"read-only"}\n' >"$TASKS"
FAKE_CODEX_LOG="$WORK_DIR/cli-log.jsonl" FAKE_CODEX_STATE="$WORK_DIR/cli-state" \
  node "$ROOT/dist/cli.js" run --tasks "$TASKS" --out "$CLI_OUT" --parallel 1 --timeout 10 --stall 5 --bin "$FAKE_CODEX" >/tmp/codex-subagents-cli.out
grep -q '"status": "ok"' /tmp/codex-subagents-cli.out || fail "CLI run should report ok"
test -f "$CLI_OUT/cli.md" || fail "CLI run should write last message"
pass "CLI run works with fake codex"
