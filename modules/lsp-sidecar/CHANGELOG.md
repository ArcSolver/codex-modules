# Changelog

All notable changes to this module are documented here.

## [Unreleased]

### Changed

- Raised the minimum supported Node.js version to `>=24` (current Active LTS); Node 20 reached end-of-life in April 2026.

## [0.1.0] - 2026-07-06

### Added

- Initial alpha release: stdio MCP server exposing `lsp_diagnostics`, `lsp_definition`, `lsp_hover`, and `lsp_workspace_symbol` backed by local LSP servers.
- Added TypeScript, ESLint, and Biome server support discovered from `node_modules/.bin` and `PATH` only — no automatic downloads.
- Added lazy LSP client spawn with nearest-root detection, push/pull diagnostics merging, and idle shutdown.
- Added `doctor` command reporting server availability per workspace root.
- Added offline verification with an MCP round-trip and an intentional-type-error diagnostics check.
