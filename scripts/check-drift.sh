#!/usr/bin/env bash
# Detect new stable Codex releases, verify the module matrix, and report drift.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$REPO_ROOT/codex-versions.toml"
LOG_DIR="$REPO_ROOT/.work/logs"
VERIFY_LOG="$LOG_DIR/drift-verify.log"

mkdir -p "$LOG_DIR"

pin() {
  sed -n "s/^$1 = \"\(.*\)\"/\1/p" "$PINS"
}

stable_from_check_latest() {
  sed -nE '/^[0-9]+\.[0-9]+\.[0-9]+$/ { p; q; }'
}

replace_latest_pin() {
  local version="$1"
  sed -i.bak -E "s/^latest = \".*\"/latest = \"$version\"/" "$PINS"
  rm -f "$PINS.bak"
}

matrix_summary() {
  awk '/^== matrix summary$/ { capture=1; next } capture { print }' "$VERIFY_LOG"
}

require_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree is not clean; refusing to run drift automation" >&2
    git status --short >&2
    exit 1
  fi
}

create_pr() {
  local version="$1"
  local branch="drift/codex-$version"
  local body_file
  body_file="$(mktemp)"

  {
    echo "Detected Codex stable release $version and verified the module matrix."
    echo
    echo "Matrix summary:"
    echo '```'
    matrix_summary
    echo '```'
  } >"$body_file"

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git checkout -B "$branch"
  git add "$PINS"
  git commit -m "Bump Codex latest pin to $version"
  git fetch origin "$branch:refs/remotes/origin/$branch" >/dev/null 2>&1 || true
  git push --force-with-lease --set-upstream origin "$branch"

  if gh pr view "$branch" --json url --jq .url >/dev/null 2>&1; then
    echo "PR already exists for $branch"
  else
    gh pr create \
      --base "${DEFAULT_BRANCH:-main}" \
      --head "$branch" \
      --title "Bump Codex latest pin to $version" \
      --body-file "$body_file"
  fi

  rm -f "$body_file"
}

create_issue() {
  local version="$1"
  local body_file
  body_file="$(mktemp)"

  {
    echo "Codex stable release $version was detected, but module verification failed after bumping the latest pin."
    echo
    echo "Failure log tail:"
    echo '```'
    tail -n 120 "$VERIFY_LOG"
    echo '```'
  } >"$body_file"

  gh issue create \
    --title "codex drift detected for $version" \
    --body-file "$body_file"

  rm -f "$body_file"
}

main() {
  cd "$REPO_ROOT"
  require_clean_worktree

  local current_latest
  current_latest="$(pin latest)"
  [[ -n "$current_latest" ]] || { echo "missing latest pin in $PINS" >&2; exit 1; }

  local check_output stable_latest
  check_output="$(scripts/codex-testbed.sh check-latest)"
  stable_latest="$(printf '%s\n' "$check_output" | stable_from_check_latest || true)"

  if [[ -z "$stable_latest" ]]; then
    echo "No stable Codex release found in check-latest output:"
    printf '%s\n' "$check_output"
    exit 0
  fi

  if [[ "$stable_latest" == "$current_latest" ]]; then
    echo "Codex latest pin is current: $current_latest"
    exit 0
  fi

  echo "New stable Codex release detected: $stable_latest (pinned latest: $current_latest)"
  replace_latest_pin "$stable_latest"

  if scripts/verify-all.sh -v "min latest" 2>&1 | tee "$VERIFY_LOG"; then
    create_pr "$stable_latest"
  else
    create_issue "$stable_latest"
    exit 1
  fi
}

main "$@"
