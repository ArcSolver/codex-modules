<p align="right">English | <a href="README.ko.md">한국어</a></p>

# @codex-modules/hooks

`codex-hooks` installs, removes, trusts, diagnoses, and wraps Codex lifecycle hooks.

It supports two backends:

- installed: merge command hooks into `$CODEX_HOME/hooks.json`, preserve foreign hooks, and write trusted hook hashes to `$CODEX_HOME/config.toml`.
- session-flags: build `codex exec` argv fragments such as `-c hooks.SessionStart=[...]` for one invocation.

## install

```bash
npm install -g @codex-modules/hooks
```

Or from source:

```bash
npm install
npm run build
```

Use `--codex-home DIR` or `CODEX_HOME=DIR` for sandboxed installs. The library never needs another module at runtime.

## usage

Create a `hookset.json`:

```json
{
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        {
          "type": "command",
          "command": "/path/to/hook.sh",
          "timeout": 5,
          "statusMessage": "Starting hook"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/path/to/hook.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

Installed backend:

```bash
codex-hooks plan --hooks hookset.json --codex-home /tmp/codex-home
codex-hooks apply --hooks hookset.json --codex-home /tmp/codex-home
codex-hooks trust --codex-home /tmp/codex-home
codex-hooks status --codex-home /tmp/codex-home
```

Wrapper backend:

```bash
codex-hooks exec-args --hooks hookset.json
# Copy the printed argv after `codex exec`, then add your prompt.
```

For scripts, prefer JSON and pass the returned array directly:

```bash
codex-hooks exec-args --hooks hookset.json --json
```

By default `exec-args` includes `--dangerously-bypass-hook-trust`, because session flags do not have persisted trust state. Use `--no-bypass-trust` to omit it.

## how it works

The installed backend reads `$CODEX_HOME/hooks.json`, validates the PascalCase Codex hook events, and appends only missing command hooks. Foreign hooks are preserved. Re-running `apply` is idempotent for the same event, matcher, and command.

Installed entries are tracked in `$CODEX_HOME/.codex-hooks-manifest.json`. `remove` uses that manifest to delete only entries owned by `codex-hooks`, then removes the managed trust block from `config.toml`.

`trust` calls Codex app-server method `hooks/list` with `{ cwds }`, reads each installed hook `key` and `currentHash`, and writes:

```toml
[hooks.state."<key>"]
trusted_hash = "sha256:..."
enabled = true
```

Those TOML entries are contained in a managed block owned by `codex-hooks`, then validated before writing.

Version matrix:

| Codex version | installed backend | session-flags backend |
| --- | --- | --- |
| 0.139.x | hooks/list discovery and hooks.state trust verified; exec firing was not observed | warn: exec-path firing unverified/broken (measured: 0.139 no-fire) |
| 0.142+ | expected to discover installed hooks | ok: session flag firing measured on 0.142.5 |

`doctor` reports the Codex binary, version, `hooks` feature state, `hooks/list` availability, discovered hooks, and the session-flags version gate.

## uninstall-rollback

Every change to `hooks.json` and `config.toml` is backed up before writing. Backups live next to the target file under `.codex-kit-backups/`, for example:

```text
$CODEX_HOME/.codex-kit-backups/hooks.json.2026-07-05T00-00-00-000Z.12345.bak
```

Remove managed entries:

```bash
codex-hooks remove --codex-home "$CODEX_HOME"
```

If `codex-hooks` originally created `hooks.json` and no hooks remain, delete it during removal:

```bash
codex-hooks remove --codex-home "$CODEX_HOME" --delete-created-file
```

Manual rollback from a backup:

```bash
cp "$CODEX_HOME/.codex-kit-backups/hooks.json.<stamp>.bak" "$CODEX_HOME/hooks.json"
cp "$CODEX_HOME/.codex-kit-backups/config.toml.<stamp>.bak" "$CODEX_HOME/config.toml"
```

## Attribution

The merge and ownership patterns are based on the MIT-licensed `plastic-labs/codex-honcho` project: https://github.com/plastic-labs/codex-honcho

The trust automation pattern is based on the MIT-licensed `aannoo/hcom` project: https://github.com/aannoo/hcom

The local configuration helper code in `src/kit/` is adapted from this repository's `modules/config-kit` package.
