#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-config-kit-verify.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

pass() {
  printf 'PASS %s\n' "$1"
}

skip() {
  printf 'SKIP %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

npm --prefix "$ROOT" run build >/dev/null

ROOT="$ROOT" WORK_DIR="$WORK_DIR" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const api = await import(pathToFileURL(join(process.env.ROOT, "dist", "index.js")).href);
const {
  appendChange,
  backupFile,
  insertUnderTomlTable,
  listManagedBlocks,
  readChanges,
  readJson,
  renderManagedBlock,
  resolveCodexHome,
  spliceManagedBlock,
  validateToml,
  writeFileAtomic,
  writeJsonAtomic,
} = api;

const workDir = process.env.WORK_DIR;
assert.ok(workDir);

assert.equal(resolveCodexHome({ CODEX_HOME: "/tmp/codex-home" }), "/tmp/codex-home");
assert.ok(resolveCodexHome({}).endsWith("/.codex"));
console.log("PASS resolveCodexHome honors CODEX_HOME fallback");

const managedSeed = "alpha=1\n# outside marker stays byte-for-byte\nomega=2\n";
const withBlock = spliceManagedBlock(managedSeed, "owner", "block-a", "x = 1\n");
const withBlockTwice = spliceManagedBlock(withBlock, "owner", "block-a", "x = 1\n");
assert.equal(withBlockTwice, withBlock);
assert.ok(withBlock.startsWith("alpha=1\n# outside marker stays byte-for-byte\nomega=2\n"));
assert.deepEqual(listManagedBlocks(withBlock, "owner"), [{ owner: "owner", blockId: "block-a", body: "x = 1" }]);
assert.equal(renderManagedBlock("owner", "block-a", "x = 1"), "# >>> owner:block-a managed\nx = 1\n# <<< owner:block-a\n");
console.log("PASS managed block splice is idempotent and listable");

const replaced = spliceManagedBlock(withBlock, "owner", "block-a", "x = 2");
assert.ok(replaced.includes("x = 2"));
assert.equal(spliceManagedBlock(replaced, "owner", "block-a", null).trim(), managedSeed.trim());
console.log("PASS managed block replace/remove preserves marker-external content");

const atomicPath = join(workDir, "atomic.txt");
writeFileSync(atomicPath, "before", { mode: 0o640 });
writeFileAtomic(atomicPath, "after");
assert.equal(readFileSync(atomicPath, "utf8"), "after");
assert.equal(statSync(atomicPath).mode & 0o777, 0o640);
assert.equal(readdirSync(workDir).some(name => name.includes(".atomic.txt.") && name.endsWith(".tmp")), false);
console.log("PASS atomic write preserves mode and leaves no temp file");

const backupPath = backupFile(atomicPath);
assert.ok(backupPath);
assert.ok(existsSync(backupPath));
assert.equal(readFileSync(backupPath, "utf8"), "after");
console.log("PASS backupFile creates timestamped backup");

const toml = `# top comment
model = "gpt-5"

[mcp_servers]
# existing mcp comment
existing = "yes"

[features]
hooks = true # inline comment
`;
const inserted = insertUnderTomlTable(toml, "mcp_servers", ['managed = "ok"']);
assert.ok(inserted.includes('# top comment\nmodel = "gpt-5"'));
assert.ok(inserted.includes('# existing mcp comment\nexisting = "yes"\nmanaged = "ok"\n\n[features]'));
assert.ok(inserted.includes('hooks = true # inline comment'));
assert.deepEqual(validateToml(inserted), { ok: true });
assert.throws(() => insertUnderTomlTable(toml, "missing", ['x = 1']), /TOML table not found/);
console.log("PASS insertUnderTomlTable targets table end without reserializing comments");

assert.deepEqual(validateToml('name = "ok"\n'), { ok: true });
assert.equal(validateToml('name = \n').ok, false);
console.log("PASS validateToml reports valid and invalid TOML");

const jsonPath = join(workDir, "data.json");
writeJsonAtomic(jsonPath, { value: 1 });
assert.deepEqual(readJson(jsonPath), { value: 1 });
const jsonBackup = writeJsonAtomic(jsonPath, { value: 2 }, { backup: true });
assert.ok(jsonBackup);
assert.deepEqual(readJson(jsonPath), { value: 2 });
assert.deepEqual(JSON.parse(readFileSync(jsonBackup, "utf8")), { value: 1 });
console.log("PASS readJson/writeJsonAtomic round-trip with backup");

const manifestPath = join(workDir, "manifest", "changes.jsonl");
appendChange(manifestPath, { ts: "2026-07-05T00:00:00.000Z", action: "write", file: jsonPath, backup: jsonBackup });
assert.deepEqual(readChanges(manifestPath), [{ ts: "2026-07-05T00:00:00.000Z", action: "write", file: jsonPath, backup: jsonBackup }]);
console.log("PASS change manifest append/read works");
NODE

if ! command -v codex >/dev/null 2>&1; then
  skip "codex binary optional checks"
  exit 0
fi

CODEX_HOME_OPT="$WORK_DIR/codex-home"
mkdir -p "$CODEX_HOME_OPT/hook-bin"
cat >"$CODEX_HOME_OPT/hook-bin/noop.sh" <<'SH'
#!/bin/sh
cat >/dev/null
printf '{}\n'
SH
chmod +x "$CODEX_HOME_OPT/hook-bin/noop.sh"
cat >"$CODEX_HOME_OPT/hooks.json" <<JSON
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "$CODEX_HOME_OPT/hook-bin/noop.sh", "timeout": 5 }] }
    ]
  }
}
JSON

ROOT="$ROOT" CODEX_HOME="$CODEX_HOME_OPT" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { appServerRequest, findCodexBinary, getCodexVersion, listFeatures } = await import(pathToFileURL(join(process.env.ROOT, "dist", "index.js")).href);

const bin = findCodexBinary();
assert.ok(bin, "codex binary found");
const version = getCodexVersion(bin);
assert.ok(version, "codex version parses");
console.log("PASS getCodexVersion parses installed codex");

const features = listFeatures({ bin, env: { CODEX_HOME: process.env.CODEX_HOME } });
assert.ok(Array.isArray(features));
assert.ok(features.every(feature => typeof feature.name === "string" && typeof feature.stage === "string" && typeof feature.enabled === "boolean"));
console.log("PASS listFeatures parses codex features list");

const hooks = await appServerRequest("hooks/list", {}, { bin, codexHome: process.env.CODEX_HOME, timeoutMs: 10000 });
assert.ok(hooks && typeof hooks === "object", "hooks/list returns an object");
const data = Array.isArray(hooks.data) ? hooks.data : [];
assert.ok(data.some(source => Array.isArray(source.hooks) && source.hooks.some(hook => hook.key && hook.currentHash && typeof hook.enabled === "boolean")));
console.log("PASS appServerRequest hooks/list discovers sandbox hook");
NODE
