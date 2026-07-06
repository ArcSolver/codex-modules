# @codex-modules/session-recall

`codex-session-recall` indexes Codex transcript JSONL into a module-owned SQLite database, then searches old sessions with FTS5, lineage-aware dedupe, anchored windows, and read/around views.

It never writes to `$CODEX_HOME`. Sync is explicit: installing the package does not index transcripts or add Codex hooks.

## install

```bash
npm install -g @codex-modules/session-recall
```

Or from source:

```bash
npm install
npm run build
```

This package uses `better-sqlite3`, a native runtime dependency. If install fails, confirm that your Node version satisfies `>=20` and that your platform can install the prebuilt package or compile native addons.

## usage

Index current Codex sessions:

```bash
codex-session-recall sync
```

Use a sandboxed input root and state directory:

```bash
codex-session-recall sync --codex-home /tmp/codex-home --state-dir /tmp/session-recall
```

Search:

```bash
codex-session-recall search "SQLite FTS5"
codex-session-recall search "SQLite FTS5" --json
```

Read a session:

```bash
codex-session-recall read 019...
codex-session-recall around 019... '#18'
```

## commands

### sync

```text
codex-session-recall sync
  [--codex-home <dir>]
  [--state-dir <dir>]
  [--since <iso-or-date>]
  [--until <iso-or-date>]
  [--cwd <path-prefix>]
  [--session-id <id>]
  [--path <rollout-jsonl>]
  [--include-archived]
  [--exclude-subagents]
  [--rebuild]
  [--dry-run]
  [--json]
  [--debug-paths]
```

By default, `sync` scans `$CODEX_HOME/sessions/**/rollout-*.jsonl`. Archived sessions are excluded unless `--include-archived` is passed.

### search

```text
codex-session-recall search <query>
  [--state-dir <dir>]
  [--limit <n>]
  [--scan-limit <n>]
  [--sort relevance|newest|oldest]
  [--window <n>]
  [--bookend <n>]
  [--role user,assistant,tool,function]
  [--cwd <path-prefix>]
  [--since <iso-or-date>]
  [--until <iso-or-date>]
  [--exclude-subagents]
  [--json]
  [--debug-paths]
```

Search returns session-level results. Within one lineage, only the best matching session is returned by default.

### read

```text
codex-session-recall read <session-id>
  [--state-dir <dir>]
  [--head <n>]
  [--tail <n>]
  [--full]
  [--json]
```

### around

```text
codex-session-recall around <session-id> <msg-ref>
  [--state-dir <dir>]
  [--window <n>]
  [--json]
```

`msg-ref` is the stable session-local message sequence, for example `18` or `#18`. `line:<line_no>` is accepted for debug recovery.

## state and privacy

Default paths:

```text
codexHome = CODEX_HOME or ~/.codex
stateDir = CODEX_SESSION_RECALL_STATE_DIR or ~/.codex-modules/session-recall
dbPath = stateDir/state.sqlite
```

The SQLite database is a derived local search index. It can contain user prompts, assistant messages, tool calls, and tool outputs, capped for indexing rather than preserved as a complete source of truth. Delete it with:

```bash
rm -rf ~/.codex-modules/session-recall
```

Human output and `--json` output omit rollout absolute paths by default. Pass `--debug-paths` only when you need to inspect index provenance.

This tool searches past Codex transcripts. It is not evidence of current filesystem, web, email, app, PR, or issue state. Verify current sources directly when freshness matters.

## Attribution

Inspired by NousResearch/hermes-agent (MIT): https://github.com/NousResearch/hermes-agent
