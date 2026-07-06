# @codex-modules/lsp-sidecar

`codex-lsp-sidecar` runs a stdio MCP server that gives Codex four local language-server tools:

- `lsp_diagnostics`
- `lsp_definition`
- `lsp_hover`
- `lsp_workspace_symbol`

## install

```bash
npm install -g @codex-modules/lsp-sidecar
```

Or from source:

```bash
npm install
npm run build
```

The package has no runtime npm dependencies. Language servers are discovered from the target workspace, this module's `node_modules/.bin`, or `PATH`.

## usage

Check a workspace first:

```bash
codex-lsp-sidecar doctor --root /path/to/repo
```

Run the MCP server:

```bash
codex-lsp-sidecar serve --root /path/to/repo
```

Register directly with Codex:

```bash
codex mcp add lsp -- codex-lsp-sidecar serve --root /path/to/repo
```

Or register through this repo's MCP manager module:

```bash
codex-mcp-manager add \
  --name lsp \
  --command codex-lsp-sidecar \
  --arg serve \
  --arg --root \
  --arg /path/to/repo
```

The file-position tools use 1-based line and character values, matching editor coordinates.

## how it works

The sidecar reserves stdout for MCP frames and writes logs to stderr. It implements the small stdio JSON-RPC surface needed by Codex: `initialize`, `tools/list`, `tools/call`, and common notifications.

LSP servers are started lazily on the first relevant tool call. The sidecar never downloads language servers, installs packages, or edits Codex configuration. It currently knows how to discover TypeScript, Biome, and optional ESLint servers:

- TypeScript needs `typescript-language-server` plus a resolvable `typescript/lib/tsserver.js`.
- Biome needs a `biome` binary.
- ESLint needs a resolvable `eslint` package plus `vscode-eslint-language-server`.

All four tools are always listed. If no matching server is available for a call, the tool returns `isError: true` with structured content containing `code: "LSP_SERVER_UNAVAILABLE"`.

Idle LSP clients are shut down after 10 minutes by default. Use `--idle-ms 0` to disable idle shutdown while debugging.

## Attribution

Portions of the LSP implementation are adapted from the MIT-licensed OpenCode project by SST: https://github.com/sst/opencode

## uninstall-rollback

Remove the npm package:

```bash
npm uninstall -g @codex-modules/lsp-sidecar
```

Removing the package does not edit Codex MCP configuration. Remove the MCP registration separately:

```bash
codex mcp remove lsp
```

Or through this repo's MCP manager module:

```bash
codex-mcp-manager remove lsp
```
