# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Added

- Added the initial `codex-session-recall` CLI with explicit transcript sync, SQLite FTS5 search, anchored context windows, and read/around session views.
- Added a module-owned state directory at `~/.codex-modules/session-recall/`, with `--state-dir` and `CODEX_SESSION_RECALL_STATE_DIR` overrides.
- Added offline verification with synthetic Codex rollout JSONL fixtures.
