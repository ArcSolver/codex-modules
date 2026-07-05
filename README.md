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

```bash
npm install -g @codex-modules/<name>
```

Each module has its own README with installation, usage, verification, and rollback instructions.

Start with the module README under `modules/<name>/`.

## Design Principles

- Standalone: each module installs and runs independently.
- Reversible: uninstall and rollback paths are part of the module contract.
- Safe by default: modules must not corrupt `$CODEX_HOME`.
- Verified: each module includes runnable checks that prove it works as intended.

## License

MIT
