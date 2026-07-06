<p align="right">English | <a href="README.ko.md">한국어</a></p>

# MCP Manager

Safely manage Codex MCP server registrations with collision checks, backups,
advanced-key patches, dry-run planning, and rollback.

## What it does

`codex-mcp-manager` is a small wrapper around the official `codex mcp` CLI.
It delegates normal add, remove, list, and get operations to Codex so the
official writer and validation stay in charge, then adds the safety features
that are useful for repeatable setup scripts:

- detects name collisions before add
- creates backups before mutating `config.toml`
- records backup manifests for rollback
- supports dry-run plans
- patches advanced MCP table keys that `codex mcp add` does not expose
- rejects plaintext bearer tokens; use environment-variable references instead

The manager supports stdio servers and streamable HTTP servers.

## Install

```sh
npm install @codex-modules/mcp-manager
```

For local development inside this repository:

```sh
cd modules/mcp-manager
npm install
npm run build
```

## Usage

Add a stdio server:

```sh
codex-mcp-manager add \
  --name docs \
  --command node \
  --arg /path/to/server.js
```

Add a streamable HTTP server:

```sh
codex-mcp-manager add \
  --name web \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var MCP_WEB_TOKEN
```

Read a server definition from JSON:

```json
{
  "name": "github",
  "url": "https://mcp.example.com/github",
  "bearerTokenEnvVar": "GITHUB_MCP_TOKEN",
  "httpHeaders": {
    "X-Client": "codex"
  }
}
```

```sh
codex-mcp-manager plan --from github.json --json
codex-mcp-manager add --from github.json --force
```

Patch advanced keys under an existing `[mcp_servers.<name>]` table:

```sh
codex-mcp-manager patch github \
  --set startup_timeout_sec=20 \
  --set 'enabled_tools=["search","open"]'
```

Inspect or remove servers:

```sh
codex-mcp-manager list --json
codex-mcp-manager get github --json
codex-mcp-manager remove github
codex-mcp-manager doctor
```

Use `--codex-home DIR` on any command to target an isolated Codex home instead
of the current user's default `~/.codex`.

## API

```ts
import {
  addServer,
  doctor,
  getServer,
  listServers,
  patchServer,
  patchServerText,
  plan,
  removeServer,
  rollback,
  type ServerDef,
} from "@codex-modules/mcp-manager";

const def: ServerDef = {
  name: "web",
  url: "https://mcp.example.com/mcp",
  bearerTokenEnvVar: "MCP_WEB_TOKEN",
};

await plan(def, { codexHome: "/tmp/codex-home" });
await addServer(def, { codexHome: "/tmp/codex-home", force: true });
await patchServer("web", { startup_timeout_sec: 20 }, { codexHome: "/tmp/codex-home" });
await rollback({ codexHome: "/tmp/codex-home" });
```

`ServerDef` accepts either:

- stdio: `{ name, command, args?, env?, envVars? }`
- HTTP: `{ name, url, bearerTokenEnvVar?, httpHeaders? }`

Do not pass plaintext bearer tokens. Values named `bearer_token`,
`bearer-token`, or `bearerToken` are rejected. Store the secret in an
environment variable and pass `bearerTokenEnvVar`.

`patchServerText(content, name, keys)` is exported for fixture tests and tools
that need to preview a table patch without touching disk.

## How it works

For add, remove, list, and get, this module calls the installed `codex` binary
with `CODEX_HOME` set to the requested target directory. Before a mutating
operation, it copies `config.toml` into:

```text
<CODEX_HOME>/codex-mcp-manager-state/backups/
```

Each backup is recorded in:

```text
<CODEX_HOME>/codex-mcp-manager-state/manifest.jsonl
```

`patchServer` is intentionally narrower than a TOML rewriter. It validates the
file, inserts or replaces only the requested keys inside
`[mcp_servers.<name>]`, validates again, and asks `codex mcp get --json` to
parse the result. This avoids reserializing unrelated parts of `config.toml`.

Codex itself may reserialize an MCP server table when `codex mcp add` replaces
that table. Top-level comments and unrelated keys are expected to remain, but
comments inside the affected MCP server table are not preserved by Codex.

## Uninstall and rollback

Removing the npm package does not edit Codex configuration:

```sh
npm uninstall @codex-modules/mcp-manager
```

To undo the last change made by this module:

```sh
codex-mcp-manager rollback
```

For an isolated home:

```sh
codex-mcp-manager rollback --codex-home /tmp/codex-home
```

If the CLI is unavailable, restore manually by copying the latest backup from
`<CODEX_HOME>/codex-mcp-manager-state/backups/` over
`<CODEX_HOME>/config.toml`. The manifest at
`<CODEX_HOME>/codex-mcp-manager-state/manifest.jsonl` records which file each
backup belongs to.

## Attribution

Schema mapping was informed by `jtianling/mcps-manager` (MIT). Writer and
backup patterns were informed by `Brightwing-Systems-LLC/mcp-manager` (MIT).
