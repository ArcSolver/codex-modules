<p align="right">English | <a href="README.ko.md">한국어</a></p>

# @codex-modules/claude-provider

`codex-claude-provider` is a personal localhost provider adapter for Codex custom providers. It exposes a local Responses-compatible endpoint that Codex can call with `wire_api = "responses"` and bridges Codex function-tool turns to Claude through the Claude Agent SDK.

The adapter does not execute Codex tools itself. Claude plans a tool call, the adapter emits a Codex `function_call`, Codex owns approval and execution, and the adapter passes the returned `function_call_output` back to the active Claude turn.

## Install

```bash
npm install -g @codex-modules/claude-provider
```

Or from source:

```bash
npm install
npm run build
```

Run the CLI from this package:

```bash
node dist/cli.js doctor --json
```

When installed globally or through npm linking, the command is:

```bash
codex-claude-provider doctor --json
```

## Usage

Start the localhost adapter:

```bash
codex-claude-provider serve
```

On startup it prints one JSON line to stdout:

```json
{"baseUrl":"http://127.0.0.1:47777/v1","providerId":"claude_provider"}
```

Install the Codex provider block into an explicit Codex home:

```bash
codex-claude-provider install \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1
```

By default `install` only adds the provider block. It does not change the top-level Codex `model` or `model_provider`. To make this provider the default for that Codex home:

```bash
codex-claude-provider install \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1 \
  --set-default
```

The injected provider uses:

```toml
[model_providers.claude_provider]
name = "Claude Provider"
base_url = "http://127.0.0.1:47777/v1"
wire_api = "responses"
```

Serve options:

```bash
codex-claude-provider serve \
  --host 127.0.0.1 \
  --port 47777 \
  --model claude-provider \
  --log-level info \
  --idle-ttl-ms 1800000 \
  --request-timeout-ms 90000 \
  --tool-result-ttl-ms 600000
```

`--unsafe-log-previews` is opt-in. Without it, logs record only event metadata, lengths, and hashes, not request bodies, tool outputs, or raw Claude events.

## How It Works

The server exposes only:

- `GET /healthz`
- `POST /v1/responses`

It binds to `127.0.0.1` by default. Non-local bind hosts are rejected. Browser-origin requests, CORS preflight requests, non-JSON provider requests, and non-streaming provider requests are rejected.

Each Codex request starts a turn-scoped Claude query. The adapter reconstructs the prompt from Codex `instructions` and `input`, converts supported Codex `function` tools into conservative MCP tools, and starts the Claude Agent SDK with locked-down options:

- `settingSources: []`
- `tools: []`
- one in-process `codex_bridge` MCP server
- `permissionMode: "dontAsk"`
- `allowedTools` limited to generated `mcp__codex_bridge__<tool>` names

Only Codex `function` tools with supported JSON Schema are exposed. `namespace` and `web_search` tools are not exposed to Claude. Unsupported schemas fail closed and are omitted from the Claude tool catalog.

The adapter keeps an in-memory session registry keyed primarily by Codex `thread-id`, with fallbacks to `session-id`, `prompt_cache_key`, `x-client-request-id`, and input hash. It stores replayable SSE transcripts so duplicate retries for the same request id do not start another Claude query.

Timeouts and Claude-side errors are returned as diagnostic `output_text` followed by `response.completed`. The adapter does not emit HTTP 429 or `response.failed`.

## Diagnostics

Run:

```bash
codex-claude-provider doctor --json
```

With a sandbox Codex home:

```bash
codex-claude-provider doctor --codex-home /tmp/codex-home --json
```

With a running adapter:

```bash
codex-claude-provider doctor \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1 \
  --json
```

`doctor` checks Node, pinned runtime dependencies, `ANTHROPIC_API_KEY` shadowing, optional Codex provider config, and optional `/healthz`. It does not inspect real `~/.codex` or `~/.claude` unless you explicitly pass a Codex home path.

If `ANTHROPIC_API_KEY` is present, `serve` fails unless `ALLOW_ANTHROPIC_API_KEY=1` is also set. This keeps the adapter fail-closed when an environment key would change the Claude Agent SDK authentication path.

## Attribution

This package includes adapter code derived from the repository-local proof-of-concept script `.work/experiments/claude-provider-adapter/scripts/probe-roundtrip-bridge.mjs`.

Runtime dependencies:

- `@anthropic-ai/claude-agent-sdk` 0.3.202, license published by Anthropic in the package license file.
- `@anthropic-ai/sdk` 0.110.0, MIT.
- `@modelcontextprotocol/sdk` 1.29.0, MIT.
- `zod` 4.4.3, MIT.

## Uninstall Rollback

Remove the provider from the same Codex home used during install:

```bash
codex-claude-provider uninstall --codex-home /tmp/codex-home
```

Install always creates a backup before writing:

```text
<CODEX_HOME>/config.toml.codex-claude-provider.<timestamp>.bak
```

It also records install ownership in:

```text
<CODEX_HOME>/codex-modules/claude-provider-install.json
```

`uninstall` removes only the sentinel-managed provider block. If `--set-default` was used and the current top-level values still match the installed values, it restores the previous top-level `model` and `model_provider`. If the sentinel block changed after install, uninstall refuses to edit and reports the backup path.

Manual rollback:

```bash
cp <backup-path> <CODEX_HOME>/config.toml
```
