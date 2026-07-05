#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass() { printf 'PASS %s\n' "$1"; }
skip() { printf 'SKIP %s\n' "$1"; }

if [[ "${RUN_LIVE:-0}" != "1" ]]; then
  skip "RUN_LIVE=1 not set"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  skip "codex not found"
  exit 0
fi

VERSION_RAW="$(codex --version 2>&1 || true)"
VERSION="$(printf '%s\n' "$VERSION_RAW" | sed -nE 's/.*([0-9]+)\.([0-9]+)\.([0-9]+).*/\1 \2 \3/p' | head -n1)"
if [[ -z "$VERSION" ]]; then
  skip "could not parse codex version: $VERSION_RAW"
  exit 0
fi
read -r MAJOR MINOR PATCH <<<"$VERSION"
if (( MAJOR == 0 && MINOR < 142 )); then
  skip "codex $VERSION_RAW is below 0.142; session flag firing is not expected"
  exit 0
fi

npm run build >/dev/null

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/codex-hooks-live.XXXXXX")"
CODEX_HOME="$SANDBOX/codex-home"
mkdir -p "$CODEX_HOME/bin" "$SANDBOX/work"
LOG="$CODEX_HOME/live-events.jsonl"
HOOK_CMD="$CODEX_HOME/bin/live-hook.sh"
cat > "$HOOK_CMD" <<SH
#!/bin/sh
cat >> "$LOG"
printf '\\n' >> "$LOG"
printf '{}\\n'
SH
chmod +x "$HOOK_CMD"

HOOKSET="$SANDBOX/hookset.json"
cat > "$HOOKSET" <<JSON
{
  "SessionStart": [
    {
      "hooks": [
        { "type": "command", "command": "$HOOK_CMD", "timeout": 5 }
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

mapfile -t ARGS < <(node --input-type=module <<NODE
import { buildExecArgs } from "./dist/index.js";
import { readFileSync } from "node:fs";
for (const arg of buildExecArgs(JSON.parse(readFileSync("$HOOKSET", "utf8")))) console.log(arg);
NODE
)

(
  cd "$SANDBOX/work"
  CODEX_HOME="$CODEX_HOME" codex exec --skip-git-repo-check --json "${ARGS[@]}" "Say OK." < /dev/null >/dev/null
)

grep -q '"hook_event_name":"SessionStart"' "$LOG"
grep -q '"hook_event_name":"Stop"' "$LOG"
pass "session flag hooks fired on codex $VERSION_RAW"
