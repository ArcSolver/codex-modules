# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Changed

- Raised the minimum supported Node.js version to `>=24` (current Active LTS); Node 20 reached end-of-life in April 2026.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release for installing, removing, trusting, diagnosing, and wrapping Codex lifecycle hooks.
- Added installed backend support for merging command hooks into `$CODEX_HOME/hooks.json` while preserving foreign hooks.
- Added session-flags backend support for generating `codex exec` argv fragments for one invocation.
- Added trust automation through Codex app-server `hooks/list` and managed `hooks.state` entries in `config.toml`.
- Added doctor reporting for Codex binary/version, hooks feature state, hooks/list availability, discovered hooks, and session-flags version gate.
- Added `discoveryWarnings` surfacing in `status()`/`doctor()` for the codex 0.142.x drift that rejects unknown top-level fields in `hooks.json`.
