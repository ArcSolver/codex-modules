# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Changed

- Raised the minimum supported Node.js version to `>=24` (current Active LTS); Node 20 reached end-of-life in April 2026.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release: dependency-free job store with `create`, `list`, `remove`, `run`, `tick`, and `install-tick` commands.
- Added schedule parsing for intervals (`30m`, `every 2h`), 5-field cron expressions, and one-shot ISO timestamps with claim-based at-most-once firing.
- Added a safe Codex lane: dry-run by default, `--execute` plus `--allow-codex` double opt-in, forced `-s read-only --ephemeral` argv, and stall/timeout supervision.
- Added wake-gate scripts (`{"wakeAgent": false}`) and a credential-exfiltration guard that scans prompts, scripts, and slot values.
- Added blueprints (`custom-reminder`, `repo-health-check`) and a user-level launchd/crontab tick installer that only writes with `--write`.
