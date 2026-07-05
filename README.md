# codex-modules

Small, self-contained modules that make the official OpenAI Codex app/CLI truly yours.

Each module is standalone, installable, and reversible. Install a module, run it, and keep using the official Codex app/CLI with the behavior you need.

## What Is This

codex-modules is a collection of production-quality modules for extending and customizing the official OpenAI Codex app/CLI without turning your setup into a fork.

The first module focuses on adding custom models to the Codex app's model-selection UI.

## Modules

| Module | What it does | Status |
| --- | --- | --- |
| `custom-models` | Add any Responses-API-compatible model to the Codex app's model picker | alpha |

## Getting Started

Each module has its own README with installation, usage, verification, and rollback instructions.

Start with the module README under `modules/<name>/`.

## Design Principles

- Standalone: each module installs and runs independently.
- Reversible: uninstall and rollback paths are part of the module contract.
- Safe by default: modules must not corrupt `$CODEX_HOME`.
- Verified: each module includes runnable checks that prove it works as intended.

## License

MIT
