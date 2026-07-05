#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-skills-verify.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

make_skill() {
  local dir="$1"
  local name="$2"
  local description="$3"
  mkdir -p "$dir/scripts" "$dir/references" "$dir/assets"
  cat >"$dir/SKILL.md" <<EOF
---
name: $name
description: $description
---

Use this skill for $name verification.
EOF
  printf 'echo %s\n' "$name" >"$dir/scripts/run.sh"
  printf 'reference for %s\n' "$name" >"$dir/references/ref.txt"
  printf 'asset for %s\n' "$name" >"$dir/assets/asset.txt"
}

make_invalid_skill() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/SKILL.md" <<'EOF'
---
name: invalid-skill
---

Missing description.
EOF
}

make_claude_skill() {
  local dir="$1"
  mkdir -p "$dir"
  cat >"$dir/SKILL.md" <<'EOF'
---
name: claude-skill
description: Claude skill with a permission hint.
allowed-tools: Bash, Read
---

Claude-compatible skill body.
EOF
}

npm --prefix "$ROOT" run build >/dev/null

SANDBOX_HOME="$WORK_DIR/home"
SANDBOX_CODEX_HOME="$WORK_DIR/codex-home"
SANDBOX_REPO="$WORK_DIR/repo"
mkdir -p "$SANDBOX_HOME" "$SANDBOX_CODEX_HOME" "$SANDBOX_REPO"

make_skill "$WORK_DIR/src-user" "user-skill" "User root fixture skill."
make_skill "$WORK_DIR/src-legacy" "legacy-skill" "Legacy root fixture skill."
make_skill "$WORK_DIR/src-repo" "repo-skill" "Repo root fixture skill."
make_invalid_skill "$WORK_DIR/src-invalid"
make_claude_skill "$WORK_DIR/src-claude"

HOME="$SANDBOX_HOME" CODEX_HOME="$SANDBOX_CODEX_HOME" REPO_ROOT="$SANDBOX_REPO" SRC_ROOT="$WORK_DIR" MODULE_ROOT="$ROOT" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const {
  installSkill,
  listSkills,
  probe,
  removeSkill,
  rollback,
  validateSkill,
  convertClaudeSkill,
} = await import(pathToFileURL(join(process.env.MODULE_ROOT, "dist/index.js")).href);

const roots = {
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  repoRoot: process.env.REPO_ROOT,
};
const src = process.env.SRC_ROOT;

installSkill(join(src, "src-user"), { ...roots, target: "user" });
installSkill(join(src, "src-legacy"), { ...roots, target: "legacy" });
installSkill(join(src, "src-repo"), { ...roots, target: "repo" });
let listed = listSkills(roots);
assert.deepEqual(listed.user.map(skill => skill.name), ["user-skill"]);
assert.deepEqual(listed.legacy.map(skill => skill.name), ["legacy-skill"]);
assert.deepEqual(listed.repo.map(skill => skill.name), ["repo-skill"]);

const invalid = validateSkill(join(src, "src-invalid"));
assert.equal(invalid.ok, false);
assert.ok(invalid.warnings.some(warning => warning.includes("description")));

const converted = convertClaudeSkill(join(src, "src-claude"));
assert.equal(converted.ok, true);
assert.ok(converted.warnings.some(warning => warning.includes("allowed-tools")));

let duplicateFailed = false;
try {
  installSkill(join(src, "src-user"), { ...roots, target: "user" });
} catch {
  duplicateFailed = true;
}
assert.equal(duplicateFailed, true);

const forced = installSkill(join(src, "src-user"), { ...roots, target: "user", force: true });
assert.ok(forced.backupDir);
assert.ok(existsSync(forced.backupDir));
assert.ok(readdirSync(join(roots.home, ".agents", "skills", ".codex-skills-backups")).length > 0);

const probeResult = probe(roots);
if (probeResult.skipped) {
  console.log("PASS probe skipped because codex is not installed");
} else {
  assert.equal(probeResult.ok, true, JSON.stringify(probeResult.skills));
  console.log("PASS probe sees installed skills through codex debug prompt-input");
}

const removed = removeSkill("legacy-skill", { ...roots, target: "legacy" });
assert.ok(existsSync(removed.backupDir));
listed = listSkills(roots);
assert.deepEqual(listed.legacy.map(skill => skill.name), []);

const restored = rollback({ ...roots, target: "legacy" });
assert.equal(restored.ok, true);
listed = listSkills(roots);
assert.deepEqual(listed.legacy.map(skill => skill.name), ["legacy-skill"]);
NODE
pass "API install/list/validate/force/remove/rollback checks passed"

LIST_OUTPUT="$(HOME="$SANDBOX_HOME" CODEX_HOME="$SANDBOX_CODEX_HOME" node "$ROOT/dist/cli.js" list --repo-root "$SANDBOX_REPO")"
[[ "$LIST_OUTPUT" == *"user-skill"* ]] || fail "CLI list should show user-skill"
[[ "$LIST_OUTPUT" == *"legacy-skill"* ]] || fail "CLI list should show legacy-skill"
[[ "$LIST_OUTPUT" == *"repo-skill"* ]] || fail "CLI list should show repo-skill"
pass "CLI list reports all three roots"
