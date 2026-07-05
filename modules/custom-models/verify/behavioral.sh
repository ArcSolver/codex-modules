#!/usr/bin/env bash
# Behavioral check against the real codex CLI: an injected model must render
# in `codex debug models` (the same catalog surface the Codex app picker reads),
# and disappear again after rollback. Runs entirely in a sandbox CODEX_HOME.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP: codex CLI not installed"
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-custom-models-behavioral.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SB="$WORK_DIR/codex-home"
mkdir -p "$SB"

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

# Seed the sandbox with a native catalog. The real models_cache.json is
# preferred (it is a model catalog, no secrets); fixture as fallback.
if [[ -f "$HOME/.codex/models_cache.json" ]]; then
  cp "$HOME/.codex/models_cache.json" "$SB/models_cache.json"
else
  cp "$ROOT/verify/fixtures/models_cache.json" "$SB/models_cache.json"
fi
printf 'model = "gpt-5.5"\n' > "$SB/config.toml"

node "$CLI" add \
  --codex-home "$SB" \
  --provider veritest \
  --base-url "http://127.0.0.1:9/v1" \
  --model dummy-model-x \
  --no-requires-openai-auth \
  --set-default >/dev/null

CODEX_HOME="$SB" codex debug models | python3 -c '
import json, sys
data = json.load(sys.stdin)
models = data if isinstance(data, list) else data.get("models", [])
hits = [m for m in models if m.get("slug") == "veritest/dummy-model-x"]
if not hits:
    print("injected slug missing from effective catalog", file=sys.stderr)
    sys.exit(1)
if hits[0].get("visibility") != "list":
    print(f"unexpected visibility: {hits[0].get('visibility')}", file=sys.stderr)
    sys.exit(1)
'
pass "injected model renders in codex debug models with visibility=list"

node "$CLI" rollback --codex-home "$SB" >/dev/null
if CODEX_HOME="$SB" codex debug models | grep -q veritest; then
  fail "rolled-back model still present in effective catalog"
fi
pass "rollback removes model from effective catalog"
