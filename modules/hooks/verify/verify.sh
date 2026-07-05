#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }
skip() { printf 'SKIP %s\n' "$1"; }

npm run build >/dev/null

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/codex-hooks-verify.XXXXXX")"
CODEX_HOME="$SANDBOX/codex-home"
mkdir -p "$CODEX_HOME/bin"
mkdir -p "$SANDBOX/work"
HOOK_CMD="$CODEX_HOME/bin/owned-hook.sh"
FOREIGN_CMD="$CODEX_HOME/bin/foreign-hook.sh"
printf '#!/bin/sh\ncat >/dev/null\nprintf "{}\\n"\n' > "$HOOK_CMD"
printf '#!/bin/sh\ncat >/dev/null\nprintf "{}\\n"\n' > "$FOREIGN_CMD"
chmod +x "$HOOK_CMD" "$FOREIGN_CMD"

cat > "$CODEX_HOME/hooks.json" <<JSON
{
  "description": "foreign seed",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "$FOREIGN_CMD", "timeout": 3 }
        ]
      }
    ]
  }
}
JSON

HOOKSET="$SANDBOX/hookset.json"
cat > "$HOOKSET" <<JSON
{
  "SessionStart": [
    {
      "matcher": "startup",
      "hooks": [
        { "type": "command", "command": "$HOOK_CMD", "timeout": 5, "statusMessage": "Owned hook" }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        { "type": "command", "command": "$HOOK_CMD", "timeout": 5 }
      ]
    }
  ]
}
JSON

node --input-type=module <<NODE
import { apply } from "./dist/index.js";
import { readFileSync } from "node:fs";
const hookSet = JSON.parse(readFileSync("$HOOKSET", "utf8"));
const result = apply(hookSet, { codexHome: "$CODEX_HOME" });
if (!result.backup) throw new Error("expected hooks.json backup");
NODE

node --input-type=module <<NODE
import { readFileSync } from "node:fs";
const hooks = JSON.parse(readFileSync("$CODEX_HOME/hooks.json", "utf8")).hooks;
const sessionHooks = hooks.SessionStart[0].hooks.map(h => h.command);
if (!sessionHooks.includes("$FOREIGN_CMD")) throw new Error("foreign hook not preserved");
if (!sessionHooks.includes("$HOOK_CMD")) throw new Error("owned SessionStart hook missing");
if (!hooks.Stop?.[0]?.hooks?.some(h => h.command === "$HOOK_CMD")) throw new Error("owned Stop hook missing");
const manifest = JSON.parse(readFileSync("$CODEX_HOME/.codex-hooks-manifest.json", "utf8"));
if (manifest.entries.length !== 2) throw new Error("expected 2 manifest entries, got " + manifest.entries.length);
NODE
pass "apply preserves foreign hooks and records owned entries"

node --input-type=module <<NODE
import { apply } from "./dist/index.js";
import { readFileSync } from "node:fs";
const hookSet = JSON.parse(readFileSync("$HOOKSET", "utf8"));
apply(hookSet, { codexHome: "$CODEX_HOME" });
const hooks = JSON.parse(readFileSync("$CODEX_HOME/hooks.json", "utf8")).hooks;
const ownedSession = hooks.SessionStart[0].hooks.filter(h => h.command === "$HOOK_CMD");
if (ownedSession.length !== 1) throw new Error("expected idempotent SessionStart insert, got " + ownedSession.length);
NODE
pass "reapply is idempotent"

SNAPSHOT="$(node --input-type=module <<'NODE'
import { buildExecArgs } from "./dist/index.js";
const args = buildExecArgs({
  SessionStart: [
    {
      matcher: "startup|resume",
      hooks: [
        { type: "command", command: 'node -e "console.log(1)"', timeout: 5, statusMessage: "Hi" }
      ]
    }
  ],
  Stop: [
    {
      hooks: [
        { type: "command", command: "printf done", timeout: 1 }
      ]
    }
  ]
});
process.stdout.write(JSON.stringify(args));
NODE
)"
EXPECTED='["--dangerously-bypass-hook-trust","-c","hooks.SessionStart=[{matcher=\"startup|resume\",hooks=[{type=\"command\",command=\"node -e \\\"console.log(1)\\\"\",timeout=5,statusMessage=\"Hi\"}]}]","-c","hooks.Stop=[{hooks=[{type=\"command\",command=\"printf done\",timeout=1}]}]"]'
[[ "$SNAPSHOT" == "$EXPECTED" ]] || fail "buildExecArgs snapshot mismatch: $SNAPSHOT"
pass "buildExecArgs matches snapshot"

if command -v codex >/dev/null 2>&1; then
  node --input-type=module <<NODE
import { trust, status } from "./dist/index.js";
const before = await status({ codexHome: "$CODEX_HOME", cwds: ["$SANDBOX/work"] });
if (before.appServerError) throw new Error(before.appServerError);
if (before.hooks.length === 0) throw new Error("hooks/list discovered no hooks");
await trust({ codexHome: "$CODEX_HOME", cwds: ["$SANDBOX/work"] });
const after = await status({ codexHome: "$CODEX_HOME", cwds: ["$SANDBOX/work"] });
const trusted = after.hooks.filter(h => h.trustStatus === "trusted" || h.trustStatus === "Trusted");
if (trusted.length === 0) throw new Error("trustStatus did not become trusted");
NODE
  pass "codex hooks/list discovery and trust"
else
  skip "codex not found; hooks/list and trustStatus check"
fi

node --input-type=module <<NODE
import { remove } from "./dist/index.js";
remove({ codexHome: "$CODEX_HOME" });
NODE

node --input-type=module <<NODE
import { existsSync, readFileSync } from "node:fs";
const hooks = JSON.parse(readFileSync("$CODEX_HOME/hooks.json", "utf8")).hooks;
const sessionHooks = hooks.SessionStart?.[0]?.hooks?.map(h => h.command) ?? [];
if (!sessionHooks.includes("$FOREIGN_CMD")) throw new Error("foreign hook removed unexpectedly");
if (sessionHooks.includes("$HOOK_CMD")) throw new Error("owned SessionStart hook still present");
if (hooks.Stop) throw new Error("empty owned Stop group was not removed");
const config = existsSync("$CODEX_HOME/config.toml") ? readFileSync("$CODEX_HOME/config.toml", "utf8") : "";
if (config.includes("codex-hooks:hooks-state")) throw new Error("managed trust block still present");
if (existsSync("$CODEX_HOME/.codex-hooks-manifest.json")) throw new Error("manifest still present");
NODE
pass "remove preserves foreign hooks and removes managed block"

BACKUP_COUNT="$(find "$CODEX_HOME/.codex-kit-backups" -type f 2>/dev/null | wc -l | tr -d ' ')"
[[ "$BACKUP_COUNT" -gt 0 ]] || fail "expected backup files"
pass "backup files exist"
