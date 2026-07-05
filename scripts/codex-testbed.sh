#!/usr/bin/env bash
# Pinned-Codex testbed: download and cache official release binaries so
# verification runs against known versions instead of whatever is on PATH.
#
# Usage:
#   scripts/codex-testbed.sh <version|min|latest>   # ensure cached, print binary path
#   scripts/codex-testbed.sh check-latest           # print recent upstream versions, newest first
#
# Pins live in codex-versions.toml. Binaries are cached under .work/testbed/
# (gitignored) — nothing heavy is ever committed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$REPO_ROOT/codex-versions.toml"
CACHE="$REPO_ROOT/.work/testbed"

pin() { sed -n "s/^$1 = \"\(.*\)\"/\1/p" "$PINS"; }

case "${1:?usage: codex-testbed.sh <version|min|latest|check-latest>}" in
  check-latest)
    # Full list, newest first — consumers filter (e.g. drift check picks the
    # first stable line, which head -1 would hide behind a newer prerelease).
    gh release list -R openai/codex --limit 15 --json tagName -q '.[].tagName' \
      | sed -n 's/^rust-v//p'
    exit 0
    ;;
  min|latest) VER="$(pin "$1")" ;;
  *) VER="$1" ;;
esac
[[ -n "$VER" ]] || { echo "no pin for '$1' in $PINS" >&2; exit 1; }

BIN="$CACHE/$VER/codex"
if [[ -x "$BIN" ]]; then echo "$BIN"; exit 0; fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
  Linux-x86_64)  TARGET="x86_64-unknown-linux-musl" ;;
  Linux-aarch64|Linux-arm64) TARGET="aarch64-unknown-linux-musl" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/openai/codex/releases/download/rust-v${VER}/codex-${TARGET}.tar.gz"
echo "fetching codex ${VER} (${TARGET})..." >&2
curl -fsSL "$URL" -o "$TMP/codex.tar.gz"
tar -xzf "$TMP/codex.tar.gz" -C "$TMP"

# The tarball ships the binary as either `codex` or `codex-<target>`.
SRC="$TMP/codex"
[[ -f "$SRC" ]] || SRC="$TMP/codex-${TARGET}"
[[ -f "$SRC" ]] || { echo "binary not found in tarball" >&2; ls "$TMP" >&2; exit 1; }

mkdir -p "$CACHE/$VER"
mv "$SRC" "$BIN"
chmod +x "$BIN"
"$BIN" --version >&2
echo "$BIN"
