# codex-modules

Small, self-contained modules that make the official OpenAI Codex app/CLI truly yours.

Each module is standalone, installable, and reversible. Install a module, run it, and keep using the official Codex app/CLI with the behavior you need.

## What Is This

codex-modules is a collection of production-quality modules for extending and customizing the official OpenAI Codex app/CLI without turning your setup into a fork.

## Modules

| Module | npm | What it does | Status |
| --- | --- | --- | --- |
| `custom-models` | `@codex-modules/custom-models` | Add any Responses-API-compatible model to the Codex app's model picker | alpha |
| `config-kit` | `@codex-modules/config-kit` | Safe-editing toolkit for Codex config surfaces: atomic writes, backups, managed blocks, feature detection, app-server RPC | alpha |
| `hooks` | `@codex-modules/hooks` | Install, trust, and manage Codex lifecycle hooks — file-based or per-invocation session flags | alpha |
| `skills` | `@codex-modules/skills` | Install, validate, convert, and manage Codex skills across all three skill roots | alpha |
| `mcp-manager` | `@codex-modules/mcp-manager` | Register MCP servers with conflict detection, backups, advanced-key patching, and rollback | alpha |
| `subagents` | `@codex-modules/subagents` | Run parallel `codex exec` sub-agent tasks with stall detection, timeouts, and resume | alpha |

## Getting Started

Install the hooks module and try a sandboxed Codex home. This example creates a
real hookset, applies it to a temporary `$CODEX_HOME`, and checks status without
touching your real Codex settings.

```bash
npm install -g @codex-modules/hooks

SANDBOX_CODEX_HOME="$(mktemp -d)"
HOOK_SCRIPT="$SANDBOX_CODEX_HOME/lifecycle-notify.sh"

cat > "$HOOK_SCRIPT" <<'SH'
#!/usr/bin/env bash
echo "codex lifecycle hook fired" >> "$CODEX_HOME/hook.log"
SH
chmod +x "$HOOK_SCRIPT"

cat > hookset.json <<JSON
{
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        {
          "type": "command",
          "command": "$HOOK_SCRIPT",
          "timeout": 5,
          "statusMessage": "Starting Codex session"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "$HOOK_SCRIPT",
          "timeout": 5
        }
      ]
    }
  ]
}
JSON

codex-hooks plan --hooks hookset.json --codex-home "$SANDBOX_CODEX_HOME"
codex-hooks apply --hooks hookset.json --codex-home "$SANDBOX_CODEX_HOME"
codex-hooks status --codex-home "$SANDBOX_CODEX_HOME"
```

Each module has its own README with installation, usage, verification, and rollback instructions.

Start with the module README under `modules/<name>/`.

Modules can also be combined. For example, use `subagents` to run two read-only
`codex exec` investigations in parallel, while `hooks` manages lifecycle
notifications for the sandboxed Codex home used by that run:

```bash
cat > tasks.jsonl <<'JSONL'
{"id":"entry-points","prompt":"Inspect this repo and summarize likely entry points. Do not edit files.","cwd":".","sandbox":"read-only"}
{"id":"test-gaps","prompt":"Inspect this repo and summarize test coverage gaps. Do not edit files.","cwd":".","sandbox":"read-only"}
JSONL

codex-subagents run --tasks tasks.jsonl --out .work/subagents/quick-start --parallel 2 --timeout 600 --stall 180 --codex-home "$SANDBOX_CODEX_HOME"
```

## Design Principles

- Standalone: each module installs and runs independently.
- Reversible: uninstall and rollback paths are part of the module contract.
- Safe by default: modules must not corrupt `$CODEX_HOME`.
- Verified: each module includes runnable checks that prove it works as intended.

## License

MIT
