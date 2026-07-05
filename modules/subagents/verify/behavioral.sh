#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${RUN_LIVE:-}" != "1" ]]; then
  echo "SKIP set RUN_LIVE=1 to run a real codex read-only task"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP codex binary not found"
  exit 0
fi

npm --prefix "$ROOT" run build >/dev/null

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-subagents-live.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

TASKS="$WORK_DIR/tasks.jsonl"
OUT="$WORK_DIR/out"
LIVE_CODEX_HOME="${CODEX_HOME:-$WORK_DIR/codex-home}"
mkdir -p "$LIVE_CODEX_HOME"
cat >"$TASKS" <<'JSONL'
{"id":"live","prompt":"Reply with LIVE_OK only.","sandbox":"read-only"}
JSONL

CODEX_HOME="$LIVE_CODEX_HOME" node "$ROOT/dist/cli.js" run --tasks "$TASKS" --out "$OUT" --parallel 1 --timeout 120 --stall 60
grep -q "LIVE_OK" "$OUT/live.md"
echo "PASS live codex read-only task"
