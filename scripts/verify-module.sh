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
# Full content copies (not just hashes): a resident Codex app can rewrite
# config.toml for unrelated reasons, so on mismatch we need the diff to
# judge whether the module is at fault.
# models_cache.json is excluded from the guard: the resident app refreshes
# it on a TTL. Its *content* is checked at the end instead.
for f in config.toml hooks.json; do
  if [[ -f "$REAL_HOME/$f" ]]; then
    cp "$REAL_HOME/$f" "$STAMP/before-$f"
  fi
done

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
for f in config.toml hooks.json; do
  if [[ -f "$STAMP/before-$f" ]]; then
    if ! diff -u "$STAMP/before-$f" "$REAL_HOME/$f"; then
      echo "FAIL: real $f changed during verification (diff above)" >&2
      exit 1
    fi
    echo "$f: unchanged"
  elif [[ -f "$REAL_HOME/$f" ]]; then
    echo "FAIL: real $f was created during verification" >&2
    exit 1
  fi
done
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
