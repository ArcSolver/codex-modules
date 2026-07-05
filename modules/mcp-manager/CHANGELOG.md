# Changelog

All notable changes to this module are documented here.

## [Unreleased]

- No changes yet.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release for safely managing Codex MCP server registrations.
- Added wrapper operations around official `codex mcp` add, remove, list, and get commands.
- Added name collision checks, dry-run planning, config backups, backup manifests, and rollback.
- Added support for stdio and streamable HTTP MCP servers.
- Added advanced-key patching for existing `[mcp_servers.<name>]` tables without reserializing unrelated TOML content.
- Added plaintext bearer token rejection in favor of environment-variable references.
