# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Changed

- Raised the minimum supported Node.js version to `>=24` (current Active LTS); Node 20 reached end-of-life in April 2026.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release for running multiple `codex exec` workers in parallel with file-based artifacts.
- Added JSONL task input, concurrency limits, wall-clock timeout handling, and stall detection based on output/log mtimes.
- Added per-task final messages, JSON event streams, and stderr logs under the requested output directory.
- Added resume behavior that skips tasks with existing final-message artifacts.
- Added native `multi_agent` diagnostics while keeping the external exec runner as the default engine.
- Added sandbox and config override guards that reject dangerous bypass values.
