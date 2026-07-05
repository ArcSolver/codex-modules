#!/usr/bin/env bash
# Verify vendored config-kit copies stay in sync with the core kit.
#
# Vendored copies are allowed exactly two intentional deltas, which are
# normalized away before comparing:
#   - a leading "// Adapted from ..." attribution header (required by MODULE_SPEC)
#   - the "#!/usr/bin/env node" shebang (+ following blank line) present only in
#     the core cli.ts, since vendored kits are not CLI entry points
# Anything else is real drift and fails the check.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$REPO_ROOT/modules/config-kit/src"
FAIL=0

normalize() {
  awk 'NR == 1 && /^#!\/usr\/bin\/env node$/ { skip_blank = 1; next }
       skip_blank && /^$/ { skip_blank = 0; next }
       { skip_blank = 0 }
       NR <= 2 && /^\/\/ Adapted from / { next }
       { print }' "$1"
}

printf '== config-kit vendor sync check\n'

if [[ ! -d "$CORE_DIR" ]]; then
  printf 'DRIFT config-kit: missing core directory %s\n' "$CORE_DIR" >&2
  printf 'exit code: 1\n'
  exit 1
fi

for kit_dir in "$REPO_ROOT"/modules/*/src/kit; do
  [[ -d "$kit_dir" ]] || continue

  module_dir="$(dirname "$(dirname "$kit_dir")")"
  module_name="$(basename "$module_dir")"
  module_fail=0
  checked=0
  details_file="$(mktemp "${TMPDIR:-/tmp}/check-kit-sync.XXXXXX")" || exit 1

  for vendored in "$kit_dir"/*; do
    [[ -f "$vendored" ]] || continue
    checked=$((checked + 1))

    file_name="$(basename "$vendored")"
    core="$CORE_DIR/$file_name"
    rel_vendor="${vendored#$REPO_ROOT/}"
    rel_core="${core#$REPO_ROOT/}"

    if [[ ! -f "$core" ]]; then
      {
        printf '  missing-core: %s has no core counterpart %s\n' "$rel_vendor" "$rel_core"
      } >>"$details_file"
      module_fail=1
      continue
    fi

    if ! diff -q <(normalize "$core") <(normalize "$vendored") >/dev/null; then
      {
        printf '  differs: %s differs from %s (after normalizing intentional deltas)\n' "$rel_vendor" "$rel_core"
        diff -u <(normalize "$core") <(normalize "$vendored") || true
      } >>"$details_file"
      module_fail=1
    fi
  done

  if [[ "$module_fail" -eq 0 ]]; then
    printf 'OK %s: %s vendored kit file(s) match config-kit/src\n' "$module_name" "$checked"
  else
    printf 'DRIFT %s: %s vendored kit file(s) checked\n' "$module_name" "$checked"
    cat "$details_file"
    FAIL=1
  fi

  rm -f "$details_file"
done

printf 'exit code: %s\n' "$FAIL"
exit "$FAIL"
