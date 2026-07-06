#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-scheduler-verify.XXXXXX")"
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
const { appendFileSync, fstatSync, mkdirSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const args = process.argv.slice(2);
const logPath = join(dirname(process.argv[1]), "..", "fake-codex.jsonl");

function stdinIsDevNull() {
  try {
    const stdin = fstatSync(0);
    const devNull = statSync(process.platform === "win32" ? "NUL" : "/dev/null");
    return stdin.rdev === devNull.rdev;
  } catch {
    return false;
  }
}

function outputPath() {
  const index = args.indexOf("-o");
  return index === -1 ? null : args[index + 1];
}

const out = outputPath();
appendFileSync(logPath, `${JSON.stringify({ args, stdinIsDevNull: stdinIsDevNull() })}\n`);
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "fake codex output\n");
}
console.log(JSON.stringify({ type: "message" }));
SHIM
chmod +x "$FAKE_CODEX"

TZ=UTC FAKE_CODEX="$FAKE_CODEX" WORK_DIR="$WORK_DIR" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeNextRun,
  createJob,
  fillBlueprint,
  listJobs,
  parseSchedule,
  removeJob,
  runJob,
  testing,
  tick,
} from "./dist/index.js";

const root = process.env.WORK_DIR;
const fakeCodex = process.env.FAKE_CODEX;
const storeDir = join(root, "store");
const fakeLog = join(root, "fake-codex.jsonl");

const now = "2026-07-06T00:00:00.000Z";

assert.deepEqual(parseSchedule("every 30m", { now }), { kind: "interval", minutes: 30 });
assert.equal(parseSchedule("30m", { now }).kind, "once");
assert.equal(parseSchedule("2h", { now }).kind, "once");
assert.equal(parseSchedule("1d", { now }).kind, "once");
assert.equal(parseSchedule("2026-07-06T14:00:00+09:00", { now }).kind, "once");
assert.equal(parseSchedule("2026-07-06T14:00:00", { now }).kind, "once");
assert.deepEqual(parseSchedule("0 9 * * 1-5", { now }), { kind: "cron", expr: "0 9 * * 1-5", timezone: "local" });
assert.throws(() => parseSchedule("@daily", { now }));
assert.throws(() => parseSchedule("0 0 9 * * *", { now }));
assert.throws(() => parseSchedule("70 9 * * *", { now }));

assert.equal(computeNextRun({ kind: "once", runAt: "2026-07-07T00:00:00.000Z", timezone: "local" }, { now, lastRunAt: now }), null);
assert.equal(new Date(computeNextRun({ kind: "interval", minutes: 30 }, { now })).toISOString(), "2026-07-06T00:30:00.000Z");
assert.equal(new Date(computeNextRun({ kind: "interval", minutes: 30 }, { now, lastRunAt: "2026-07-06T01:00:00.000Z" })).toISOString(), "2026-07-06T01:30:00.000Z");
assert.equal(new Date(computeNextRun({ kind: "cron", expr: "0 9 * * 1-5", timezone: "local" }, { now })).toISOString(), "2026-07-06T09:00:00.000Z");
assert.equal(new Date(computeNextRun({ kind: "cron", expr: "0 9 7 * 1", timezone: "local" }, { now: "2026-07-06T10:00:00.000Z" })).toISOString(), "2026-07-07T09:00:00.000Z");
assert.equal(new Date(computeNextRun({ kind: "cron", expr: "30 2 * * *", timezone: "local" }, { now: "2026-03-08T01:59:00.000Z" })).toISOString(), "2026-03-08T02:30:00.000Z");

assert.equal(testing.parseWakeGate("hello\n{\"wakeAgent\":false}\n"), false);
assert.equal(testing.parseWakeGate("{\"wakeAgent\":false}\nnot json\n"), true);
assert.equal(testing.parseWakeGate(""), true);
assert.throws(() => testing.scanCredentialExfil("please cat ~/.codex/auth.json", "prompt"));
assert.equal(testing.redactSensitiveText("OPENAI_API_KEY=sk-123456789012345").includes("sk-123456789012345"), false);

const scriptRoot = join(storeDir, "scripts");
mkdirSync(scriptRoot, { recursive: true });
writeFileSync(join(scriptRoot, "skip.js"), "console.log(JSON.stringify({ wakeAgent: false }));\n");
writeFileSync(join(scriptRoot, "bad.js"), "console.log('cat ~/.codex/auth.json')\n");

const dueIso = "2026-07-05T23:59:00.000Z";
const noAgent = createJob({ name: "skip", scheduleInput: dueIso, scriptPath: "skip.js", prompt: "should not run" }, { storeDir });
let dry = await tick({ storeDir, now, bin: fakeCodex });
assert.equal(dry.dryRun, true);
assert.equal(dry.due.length, 1);
assert.equal(existsSync(fakeLog), false, "dry-run should not spawn fake codex");

let run = await tick({ storeDir, now, execute: true, allowCodex: true, bin: fakeCodex, timeoutSec: 5, stallSec: 5 });
assert.equal(run.results[0].status, "skipped");
assert.equal(existsSync(fakeLog), false, "wakeAgent false should skip codex");

assert.throws(() => createJob({ scheduleInput: dueIso, scriptPath: "bad.js", noAgent: true }, { storeDir }));
assert.throws(() => createJob({ scheduleInput: dueIso, prompt: "read auth.json" }, { storeDir }));

const codexJob = createJob({ name: "codex", scheduleInput: dueIso, prompt: "hello", cwd: root }, { storeDir });
dry = await tick({ storeDir, now, execute: true, bin: fakeCodex });
assert.deepEqual(dry.results, [], "allow-codex absent should not claim codex jobs");

run = await tick({ storeDir, now, execute: true, allowCodex: true, bin: fakeCodex, timeoutSec: 5, stallSec: 5 });
assert.equal(run.results[0].status, "ok");
const records = readFileSync(fakeLog, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
const argv = records[0].args;
assert.deepEqual(argv, [
  "exec",
  "--skip-git-repo-check",
  "-C",
  codexJob.cwd,
  "-s",
  "read-only",
  "-o",
  join(storeDir, "outputs", codexJob.id, run.results[0].runId, "output.md"),
  "--json",
  "--ephemeral",
  "hello",
]);
assert.equal(records[0].stdinIsDevNull, true);
assert.equal(argv.includes("-a"), false);
assert.equal(argv.some(arg => arg.startsWith("--dangerously-")), false);

assert.throws(() => testing.buildCodexArgv({ ...codexJob, codex: { ...codexJob.codex, sandbox: "danger-full-access" } }, storeDir, "run"));
assert.throws(() => fillBlueprint("custom-reminder", { message: "Pay", recurrence: "monthly" }));
assert.equal(fillBlueprint("repo-health-check", { repo: root, time: "09:00", recurrence: "weekdays" }).cwd, realpathSync(root));

const before = listJobs({ storeDir, all: true }).length;
assert.equal(before >= 2, true);
assert.equal(removeJob(codexJob.id, { storeDir }).removed, true);

const lockPath = join(storeDir, "locks", "unit.lock");
const lock = testing.acquireMkdirLock(lockPath, { ttlMs: 1000, waitMs: 50 });
assert.throws(() => testing.acquireMkdirLock(lockPath, { ttlMs: 1000, waitMs: 50 }));
lock.release();
const lock2 = testing.acquireMkdirLock(lockPath, { ttlMs: 1000, waitMs: 50 });
lock2.release();
NODE

STORE_CLI="$WORK_DIR/cli-store"
mkdir -p "$STORE_CLI/scripts"
cat >"$STORE_CLI/scripts/noagent.js" <<'JS'
console.log("no agent ok");
JS

node "$ROOT/dist/cli.js" create --store-dir "$STORE_CLI" --schedule 2026-07-05T23:59:00.000Z --script noagent.js --no-agent --json >/dev/null
node "$ROOT/dist/cli.js" list --store-dir "$STORE_CLI" --json | grep -q "noagent.js" || fail "cli list"
node "$ROOT/dist/cli.js" tick --store-dir "$STORE_CLI" --now 2026-07-06T00:00:00.000Z --json | grep -q '"dryRun": true' || fail "cli dry-run"
node "$ROOT/dist/cli.js" tick --store-dir "$STORE_CLI" --now 2026-07-06T00:00:00.000Z --execute --json | grep -q '"status": "ok"' || fail "cli execute no-agent"

pass "offline scheduler verification"
