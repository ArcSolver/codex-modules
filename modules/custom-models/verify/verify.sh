#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
FIXTURE="$ROOT/verify/fixtures/models_cache.json"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-custom-models-verify.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

pass() {
  printf 'PASS %s\n' "$1"
}

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

npm --prefix "$ROOT" run build >/dev/null

HOME_ONE="$WORK_DIR/home-one"
mkdir -p "$HOME_ONE"
cp "$FIXTURE" "$HOME_ONE/models_cache.json"
cat >"$HOME_ONE/config.toml" <<'EOF'
# user config
model = "gpt-5.5"

[features]
fast_mode = false

[plugins.safe]
enabled = true
EOF
cp "$HOME_ONE/config.toml" "$WORK_DIR/original-config.toml"

node "$CLI" add \
  --codex-home "$HOME_ONE" \
  --provider openrouter \
  --name "OpenRouter" \
  --base-url "https://openrouter.example/v1" \
  --model "anthropic/claude-sonnet-4.6" \
  --set-default >/dev/null

CODEX_HOME="$HOME_ONE" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
const catalogPath = join(home, "codex-custom-models-catalog.json");
assert.ok(existsSync(catalogPath), "catalog exists");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const entry = catalog.models.find((model) => model.slug === "openrouter/anthropic/claude-sonnet-4.6");
assert.ok(entry, "custom entry exists");
assert.equal(entry.shell_type, "shell_command");
assert.equal(entry.supported_in_api, true);
assert.ok(entry.base_instructions.includes("anthropic/claude-sonnet-4.6"));
for (const field of [
  "model_messages",
  "tool_mode",
  "multi_agent_version",
  "use_responses_lite",
  "supports_websockets",
  "additional_speed_tiers",
  "service_tier",
  "service_tiers",
  "default_service_tier",
]) {
  assert.equal(Object.hasOwn(entry, field), false, `${field} should be deleted`);
}
const config = readFileSync(join(home, "config.toml"), "utf8");
const lines = config.split("\n");
const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
const root = lines.slice(0, firstTable).join("\n");
assert.ok(root.includes('model_provider = "openrouter"'), "root model_provider");
assert.ok(root.includes("model_catalog_json = "), "root model_catalog_json");
assert.ok(config.includes('[model_providers."openrouter"]'), "provider table");
assert.ok(config.includes("[features]\nfast_mode = false"), "pre-existing feature table preserved");
assert.ok(config.includes("[plugins.safe]\nenabled = true"), "pre-existing plugin table preserved");
const backupDir = join(home, "codex-custom-models-state", "backups");
assert.ok(readdirSync(backupDir).some((name) => name.endsWith("config.toml.bak")), "config backup exists");
const cache = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
assert.equal(cache.fetched_at, "2000-01-01T00:00:00Z");
assert.equal(cache.client_version, "0.0.0");
assert.ok(cache.models.some((model) => model.slug === "openrouter/anthropic/claude-sonnet-4.6"));
NODE
pass "add writes root-safe config, cloned catalog entry, backup, and expired cache"

LIST_OUTPUT="$(node "$CLI" list --codex-home "$HOME_ONE")"
[[ "$LIST_OUTPUT" == *"openrouter/anthropic/claude-sonnet-4.6"* ]] || fail "list shows registered model"
pass "list shows registered model"

node "$CLI" rollback --codex-home "$HOME_ONE" >/dev/null
cmp -s "$HOME_ONE/config.toml" "$WORK_DIR/original-config.toml" || fail "rollback restores original config bytes"
pass "rollback restores original config bytes"

node "$CLI" add \
  --codex-home "$HOME_ONE" \
  --provider openrouter \
  --name "OpenRouter" \
  --base-url "https://openrouter.example/v1" \
  --model "anthropic/claude-sonnet-4.6" \
  --set-default >/dev/null

node "$CLI" remove --codex-home "$HOME_ONE" --provider openrouter --all >/dev/null

CODEX_HOME="$HOME_ONE" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
const catalog = JSON.parse(readFileSync(join(home, "codex-custom-models-catalog.json"), "utf8"));
assert.equal(catalog.models.some((model) => model.slug === "openrouter/anthropic/claude-sonnet-4.6"), false);
const config = readFileSync(join(home, "config.toml"), "utf8");
assert.equal(config.includes('[model_providers."openrouter"]'), false);
assert.equal(config.includes('model_provider = "openrouter"'), false);
assert.equal(config.includes("model_catalog_json = "), false);
assert.ok(config.includes("[features]\nfast_mode = false"));
assert.equal(existsSync(join(home, "codex-custom-models-state", "state.json")), false);
NODE
pass "remove deletes only owned entry and cleans owned config/state"

HOME_TWO="$WORK_DIR/home-two"
mkdir -p "$HOME_TWO"
cp "$FIXTURE" "$HOME_TWO/models_cache.json"
cat >"$HOME_TWO/config.toml" <<'EOF'
model_provider = "openai"

[features]
fast_mode = false
EOF
cp "$HOME_TWO/config.toml" "$WORK_DIR/conflict-config.toml"

if node "$CLI" add \
  --codex-home "$HOME_TWO" \
  --provider openrouter \
  --base-url "https://openrouter.example/v1" \
  --model "anthropic/claude-sonnet-4.6" >/tmp/codex-custom-models-conflict.out 2>/tmp/codex-custom-models-conflict.err; then
  fail "conflict without force should abort"
fi
cmp -s "$HOME_TWO/config.toml" "$WORK_DIR/conflict-config.toml" || fail "conflict abort should preserve config"
pass "conflict without force aborts non-destructively"

node "$CLI" add \
  --codex-home "$HOME_TWO" \
  --provider openrouter \
  --base-url "https://openrouter.example/v1" \
  --model "anthropic/claude-sonnet-4.6" \
  --force >/dev/null
CODEX_HOME="$HOME_TWO" node --input-type=module <<'NODE'
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const config = readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8");
assert.ok(config.includes('model_provider = "openai"'), "force without --set-default leaves existing default");
assert.ok(config.includes('[model_providers."openrouter"]'), "provider table written with force");
assert.ok(config.includes("model_catalog_json = "), "catalog root written with force");
NODE
pass "force allows registration with pre-existing root model_provider"

DOCTOR_JSON="$(node "$CLI" doctor --codex-home "$HOME_TWO" --json)"
[[ "$DOCTOR_JSON" == *'"ok": true'* ]] || fail "doctor reports ok"
pass "doctor reports ok for sandbox registration"

