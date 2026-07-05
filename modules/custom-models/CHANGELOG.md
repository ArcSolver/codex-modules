# Changelog

All notable changes to this module are documented here.

## [Unreleased]

- No changes yet.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release for registering Responses-API-compatible model slugs in the official Codex app/CLI model picker.
- Added provider registration that writes Codex-native `config.toml`, `model_catalog_json`, and catalog JSON files under `CODEX_HOME`.
- Added catalog cloning from native Codex model entries with custom display metadata.
- Added conflict checks for root `model_provider`, root `model_catalog_json`, and provider tables, with `--force` for intentional takeover.
- Added tracked remove, transaction journals, backups, rollback, list, and doctor commands.
