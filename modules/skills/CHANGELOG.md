# Changelog

All notable changes to this module are documented here.

## [Unreleased]

- No changes yet.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release for installing, listing, removing, converting, probing, and diagnosing local Codex skills.
- Added validation for skill directories containing `SKILL.md` with required `name` and `description` frontmatter.
- Added install and list support across user, legacy `CODEX_HOME`, and repository-local skill roots.
- Added managed install manifests, backups before remove or forced replacement, and rollback.
- Added Claude skill conversion warnings for unsupported `allowed-tools` mappings.
- Added offline probe support through `codex debug prompt-input` when Codex is available.
