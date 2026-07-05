# codex-config-kit

Safe utilities for reading and editing Codex configuration surfaces.

`codex-config-kit` is a small Node library plus a minimal CLI. It is intended to
be vendored by other `codex-*` modules that need to inspect Codex state, edit
line-oriented config safely, create backups, and record enough information for
the caller to roll changes back.

## Install

```sh
npm install codex-config-kit
```

For local development inside this module:

```sh
npm install
npm run build
```

## Usage

CLI:

```sh
codex-config-kit doctor
codex-config-kit doctor --json
codex-config-kit validate-toml ~/.codex/config.toml
codex-config-kit backup ~/.codex/config.toml
```

Library:

```ts
import {
  backupFile,
  insertUnderTomlTable,
  spliceManagedBlock,
  writeFileAtomic,
} from "codex-config-kit";

const backup = backupFile(configPath);
const next = spliceManagedBlock(current, "codex-example", "settings", "enabled = true");
writeFileAtomic(configPath, next);
```

## How it works

This package does not reserialize whole Codex config files. Whole-file TOML
serialization destroys comments and formatting, so TOML support is limited to
validation and targeted insertion below an existing table header.

The safe editing primitives are:

- `backupFile`: copies an existing file into `.codex-kit-backups/` by default.
- `writeFileAtomic`: writes a same-directory temp file, preserves an existing
  file mode, then renames it into place.
- `renderManagedBlock` and `spliceManagedBlock`: own only text inside explicit
  `# >>> owner:blockId managed` and `# <<< owner:blockId` markers.
- `insertUnderTomlTable`: finds an exact `[table]` header and inserts lines just
  before the next table header, then parses the result with `smol-toml`.
- `appendChange` and `readChanges`: maintain a JSONL manifest that higher-level
  modules can use for rollback.

The Codex discovery helpers are read-only:

- `resolveCodexHome` resolves `CODEX_HOME` or falls back to `~/.codex`.
- `findCodexBinary`, `getCodexVersion`, and `listFeatures` inspect the local
  Codex CLI when present.
- `appServerRequest` starts `codex app-server`, initializes JSON-RPC over
  newline-delimited stdio, sends one request, and kills the child after the
  matching response.

## Uninstall and rollback

Removing this package only removes the helper library. It does not know which
module used it or which changes should be undone.

Higher-level modules should record every file write with `appendChange`, storing
the file path and the backup returned by `backupFile` or `writeJsonAtomic`.
Rollback should restore the recorded backup over the changed file with an
atomic write, or remove the owned managed block when no prior file existed.

Backups created by the default helper live beside the edited file:

```text
<file directory>/.codex-kit-backups/
```

## Attribution

This module is implemented in this repository.
