#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP codex binary not found"
  exit 0
fi

npm --prefix "$ROOT" run build >/dev/null

if [[ "${RUN_LIVE:-0}" != "1" ]]; then
  echo "SKIP set RUN_LIVE=1 to run a live codex exec smoke test"
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-scheduler-live.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

STORE="$WORK_DIR/store"
node "$ROOT/dist/cli.js" create --store-dir "$STORE" --schedule 1m --prompt "Return the word ok." --json >/dev/null
JOB_ID="$(node "$ROOT/dist/cli.js" list --store-dir "$STORE" --all --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>console.log(JSON.parse(s)[0].id))')"
node "$ROOT/dist/cli.js" run "$JOB_ID" --store-dir "$STORE" --execute --allow-codex --timeout 60 --stall 30 --json >/dev/null
echo "PASS live codex exec smoke"
