# Changelog

## 0.1.0

- Initial release: personal localhost provider adapter that serves Codex's Responses wire (`POST /v1/responses`, SSE) from the Claude Agent SDK. Claude plans turns and tool calls; Codex keeps owning tool execution and approvals via the `function_call` / `function_call_output` loop.
- CLI: `serve`, `install` (sentinel block + backup + manifest), `uninstall` (conflict-safe rollback), `doctor` — all with `--json` and mandatory `--codex-home`/`CODEX_HOME`.
- Locked-down Claude SDK session per Codex turn: `settingSources: []`, `tools: []`, in-process MCP bridge only; built-in filesystem/shell/web tools are never exposed.
- Fail-closed tool conversion: only `function` tools whose JSON Schema fits a conservative zod subset are exposed; `namespace` and `web_search` tools are never forwarded.
- Session state machine keyed by `(sessionKey, x-client-request-id, inputHash)` with replayable SSE transcripts; Codex retries and turn-loop requests reuse the same request id (measured on 0.139.0 and 0.142.5).
- Error policy: never emits HTTP 429 or `response.failed` (measured Codex behavior); Claude-side failures map to diagnostic `output_text` + `response.completed`.
- Security defaults: loopback-only bind, browser-origin request gate, `ANTHROPIC_API_KEY` fail-closed unless `ALLOW_ANTHROPIC_API_KEY=1`, content-free logs unless `--unsafe-log-previews`.
- Verify: offline lane with deterministic fake Claude backend and field-level SSE assertions; behavioral lane driving a pinned `codex` binary end-to-end (SKIP when absent).
