# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Changed

- Raised the minimum supported Node.js version to `>=24` (current Active LTS); Node 20 reached end-of-life in April 2026.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release of safe Codex configuration editing utilities.
- Added atomic writes, same-directory backups, and managed block rendering/splicing.
- Added targeted TOML insertion and validation without whole-file reserialization.
- Added read-only Codex discovery helpers for `CODEX_HOME`, Codex binary/version, feature listing, and app-server JSON-RPC requests.
- Added JSONL change manifests that higher-level modules can use for rollback.
