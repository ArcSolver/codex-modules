# Changelog

All notable changes to this module are documented here.

## [Unreleased]

- No changes yet.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release: `codex-session-recall` CLI with explicit transcript sync, SQLite FTS5 search, anchored context windows, and read/around session views.
- Added lineage-aware search that dedupes forked/subagent sessions and deprioritizes non-interactive sessions.
- Added a module-owned state directory at `~/.codex-modules/session-recall/`, with `--state-dir` and `CODEX_SESSION_RECALL_STATE_DIR` overrides; `$CODEX_HOME` is only ever read.
- Added incremental sync (mtime/size manifest), archived-session opt-in (`--include-archived`), and noise exclusion for non-conversational rollout lines.
- Added offline verification with synthetic Codex rollout JSONL fixtures.
