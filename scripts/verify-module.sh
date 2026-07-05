#!/usr/bin/env bash
# Orchestrator-side verification harness (pipeline step 5).
# Usage: scripts/verify-module.sh <module-dir>
#
# Runs the full standard sequence: clean install -> build -> module verify
# -> behavioral check (if present) -> real CODEX_HOME integrity guard.
set -euo pipefail

MODULE_DIR="${1:?usage: verify-module.sh <module-dir>}"
MODULE_DIR="$(cd "$MODULE_DIR" && pwd)"
REAL_HOME="${CODEX_REAL_HOME:-$HOME/.codex}"

STAMP="$(mktemp -d "${TMPDIR:-/tmp}/verify-module.XXXXXX")"
trap 'rm -rf "$STAMP"' EXIT

step() { printf '\n== %s\n' "$1"; }

# Snapshot the real Codex home before anything runs.
# models_cache.json is excluded from the hash guard: a resident Codex app
# refreshes it on a TTL, so its hash changes for unrelated reasons.
# Its *content* is checked at the end instead.
if [[ -f "$REAL_HOME/config.toml" ]]; then
  shasum "$REAL_HOME/config.toml" > "$STAMP/home-before.sha"
fi

step "clean install ($MODULE_DIR)"
npm --prefix "$MODULE_DIR" install --no-audit --no-fund > "$STAMP/install.log" 2>&1 \
  || { cat "$STAMP/install.log"; exit 1; }

step "build"
npm --prefix "$MODULE_DIR" run build

step "module verify (verify/verify.sh)"
bash "$MODULE_DIR/verify/verify.sh"

if [[ -f "$MODULE_DIR/verify/behavioral.sh" ]]; then
  step "behavioral check (verify/behavioral.sh)"
  bash "$MODULE_DIR/verify/behavioral.sh"
fi

step "real CODEX_HOME integrity"
if [[ -f "$STAMP/home-before.sha" ]]; then
  shasum -c "$STAMP/home-before.sha"
fi
if [[ -f "$REAL_HOME/models_cache.json" ]]; then
  if grep -q '"fetched_at": "2000-01-01' "$REAL_HOME/models_cache.json"; then
    echo "FAIL: real models_cache.json carries the module's expired-wrapper stamp" >&2
    exit 1
  fi
  python3 - "$REAL_HOME/models_cache.json" <<'PY'
import json, sys
models = json.load(open(sys.argv[1])).get("models", [])
routed = [m["slug"] for m in models if "/" in str(m.get("slug", ""))]
if routed:
    print(f"FAIL: real models_cache.json contains injected slugs: {routed}", file=sys.stderr)
    sys.exit(1)
PY
fi
echo "real CODEX_HOME clean"

printf '\nALL CHECKS PASSED: %s\n' "$MODULE_DIR"
