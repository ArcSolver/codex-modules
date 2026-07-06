#!/usr/bin/env bash
# Doc translation drift guard.
#
# English READMEs are canonical; README.ko.md files are derived translations.
# For every README.md with a README.ko.md sibling, warn when the English file
# has commits newer than the Korean file (translation likely out of date).
#
# Non-blocking by default (exit 0) so CI surfaces drift without failing the
# build. Pass --strict to exit 1 on drift (useful for release checklists).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STRICT=0
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=1
fi

drift=0

check_pair() {
  local en="$1"
  local ko="${en%README.md}README.ko.md"
  [[ -f "$ko" ]] || return 0

  local en_ts ko_ts
  en_ts="$(git log -1 --format=%ct -- "$en" 2>/dev/null || echo 0)"
  ko_ts="$(git log -1 --format=%ct -- "$ko" 2>/dev/null || echo 0)"

  # Untracked Korean file counts as up to date (it is being introduced now).
  if [[ -z "$ko_ts" || "$ko_ts" == "0" ]]; then
    return 0
  fi

  if [[ -n "$en_ts" && "$en_ts" -gt "$ko_ts" ]]; then
    drift=1
    local msg="translation drift: $en changed after $ko (update the Korean translation)"
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::warning file=$ko::$msg"
    fi
    echo "WARN $msg"
  fi
}

check_pair "README.md"
for en in modules/*/README.md; do
  check_pair "$en"
done

if [[ "$drift" -eq 0 ]]; then
  echo "PASS docs in sync (en/ko)"
fi

if [[ "$STRICT" -eq 1 && "$drift" -eq 1 ]]; then
  exit 1
fi
exit 0
