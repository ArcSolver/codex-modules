#!/usr/bin/env bash
# Version-matrix verification: run every module's verify sequence against
# pinned Codex versions from codex-versions.toml.
#
# Usage:
#   scripts/verify-all.sh                    # all modules x {min, latest}
#   scripts/verify-all.sh -v latest hooks    # one module, one pin
#   scripts/verify-all.sh -v "min latest 0.143.0" ...
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS="min latest"
if [[ "${1:-}" == "-v" ]]; then VERSIONS="$2"; shift 2; fi
MODULES=("$@")
if [[ ${#MODULES[@]} -eq 0 ]]; then
  MODULES=($(cd "$REPO_ROOT/modules" && ls -d */ | tr -d '/'))
fi

if ! bash "$REPO_ROOT/scripts/check-kit-sync.sh"; then
  echo "config-kit vendor sync check failed; aborting matrix" >&2
  exit 1
fi

declare -a RESULTS=()
FAIL=0
for ver in $VERSIONS; do
  BIN="$("$REPO_ROOT/scripts/codex-testbed.sh" "$ver")" || { echo "testbed fetch failed: $ver" >&2; exit 1; }
  for m in "${MODULES[@]}"; do
    printf '\n########## %s @ codex %s ##########\n' "$m" "$ver"
    if CODEX_BIN="$BIN" bash "$REPO_ROOT/scripts/verify-module.sh" "$REPO_ROOT/modules/$m"; then
      RESULTS+=("PASS  $m @ $ver")
    else
      RESULTS+=("FAIL  $m @ $ver")
      FAIL=1
    fi
  done
done

printf '\n== matrix summary\n'
printf '%s\n' "${RESULTS[@]}"
exit "$FAIL"
