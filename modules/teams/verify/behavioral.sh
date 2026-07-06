#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"
NODE_BIN="$(command -v node)"
CODEX_BIN="$(command -v codex || true)"

pass() { printf 'PASS %s\n' "$1"; }
skip() { printf 'SKIP %s\n' "$1"; exit 0; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

[[ -n "$CODEX_BIN" ]] || skip "codex binary not found"
[[ -f "$CLI" ]] || fail "dist/cli.js is missing; run npm run build first"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-teams-behavioral.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

export CODEX_HOME="$TMP/codex-home"
PROJECT="$TMP/project"
mkdir -p "$CODEX_HOME" "$PROJECT"

"$CODEX_BIN" features list >"$TMP/features-before.txt"
if ! awk '$1 == "multi_agent" && $0 ~ /stable/ && $NF == "true" { found=1 } END { exit found ? 0 : 1 }' "$TMP/features-before.txt"; then
  fail "multi_agent is not stable and enabled"
fi
pass "codex reports stable enabled multi_agent in sandbox CODEX_HOME"

cat >"$PROJECT/team.json" <<'JSON'
{
  "version": 1,
  "name": "behavioral",
  "defaults": {"model": "gpt-5.4-mini", "sandbox_mode": "read-only"},
  "members": [
    {"name": "alpha", "focus": "alpha probe", "lens": "area", "deliverable": "TEAM-RESULT alpha"},
    {"name": "beta", "focus": "beta probe", "lens": "area", "deliverable": "TEAM-RESULT beta"}
  ]
}
JSON

cd "$PROJECT"
"$NODE_BIN" "$CLI" install team.json --codex-home "$CODEX_HOME" --skip-model-check >/tmp/codex-teams-behavioral-install.out
"$CODEX_BIN" features list >"$TMP/features-after.txt"
pass "codex starts after teams agent TOML install in sandbox CODEX_HOME"

if [[ "${RUN_LIVE:-}" == "1" ]]; then
  printf 'SKIP live spawn probe requires auth-safe credential injection; auth.json is never copied by this script\n'
fi
