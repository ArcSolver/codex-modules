<p align="right">English | <a href="README.ko.md">한국어</a></p>

# @codex-modules/teams

`codex-teams` turns a `team.json` file into Codex agent TOML files, leader instructions, and durable project-local team state.

It uses Codex native stable `multi_agent_v1.spawn_agent` through a leader session. This package does not reimplement the multi-agent engine. It manages team definitions, safe install/uninstall, task leases, a journal, and a dry-run-first headless runner.

## Install

```bash
npm install -g @codex-modules/teams
```

Or from source:

```bash
npm install
npm run build
```

Use the CLI from this package:

```bash
node dist/cli.js doctor
```

When installed globally or through npm linking, the command is:

```bash
codex-teams doctor
```

## Usage

Create a starter team:

```bash
codex-teams init --preset review-panel --out team.json
codex-teams validate team.json
```

Install the team into a Codex home:

```bash
codex-teams install team.json
```

By default this writes `$CODEX_HOME/agents/<team>-<member>.toml` and records ownership in `$CODEX_HOME/agents/.codex-teams-manifest.json`. Use `--codex-home <dir>` for a sandbox or alternate Codex home.

Project-scope install is explicit:

```bash
codex-teams install team.json --scope project
```

Project scope writes `<cwd>/.codex/agents/` and prints a trust warning. It does not edit `config.toml` or mark the project trusted.

Generate the leader prompt:

```bash
codex-teams leader-prompt team.json --goal "Review this change for security and correctness"
```

Start durable state in the project:

```bash
codex-teams state init review-panel --goal "Review this change"
codex-teams task add review-panel --title "Security review"
codex-teams task claim review-panel task-001 --actor security
codex-teams note add review-panel --actor leader --text "Security and correctness can run in parallel"
```

Run is dry-run by default:

```bash
codex-teams run team.json --goal "Review this change"
```

Actual `codex exec` launch requires both opt-ins:

```bash
codex-teams run team.json --goal "Review this change" --execute --allow-codex
```

The executed runner uses `codex exec -s workspace-write --skip-git-repo-check --json --ephemeral` by default and writes run artifacts under `.codex-teams/<team>/runs/`. The runner only accepts `read-only` or `workspace-write` sandbox modes, never forwards danger-access flags, and passes the assembled prompt as one positional `codex exec` argument.

Install the optional Codex skill:

```bash
codex-teams skill install
```

## How It Works

`team.json` defines a team name, defaults, and 2 to 8 members. Member names become Codex agent types named `<team>-<member>`.

Install renders each member to TOML with:

- `name`
- `description`
- `model`
- `sandbox_mode`
- `nickname_candidates`
- `developer_instructions`

All TOML strings are basic strings with quotes, backslashes, newlines, and TOML control characters escaped. `nickname_candidates` is rendered as a string array.

Existing unmanaged files are never overwritten unless `--force` is passed. Forced overwrites are backed up first. Uninstall only touches files recorded in the manifest for the selected target root.

Project state lives in:

```text
.codex-teams/<team>/
  state.json
  tasks.json
  journal.jsonl
  artifacts/<member>/
  runs/
  locks/
```

`state.json` and `tasks.json` are written atomically under a mkdir lock. `journal.jsonl` is append-only under the same lock. Task claims use leases; expired claims are reclaimed by `task claim` and `task list --reclaim`. `CODEX_TEAMS_NOW` can override time for deterministic tests.

Leader state commands are for the leader or a human operator. Members report through their final `TEAM-RESULT: <one-line summary>` line. Workspace-write members may also leave optional artifacts, but the final message is the canonical result channel.

`doctor` reports the Codex binary, version, native feature state, model catalog availability, write access, and installed teams split into user and project scopes. `multi_agent` must be stable and enabled for a healthy native workflow. `enable_fanout` and `multi_agent_v2` are reported as under-development surfaces only.

The package has zero runtime dependencies. Its package root exports only the supported high-level helpers for team parsing, install/uninstall, doctor, prompt/run planning, and durable state/task/note operations.

## Attribution

No third-party code is included; the state protocol is an original clean-room design.

## Uninstall Rollback

Remove an installed team:

```bash
codex-teams uninstall review-panel
```

For a sandbox or project scope, use the same target root used during install:

```bash
codex-teams uninstall review-panel --codex-home /tmp/codex-home
codex-teams uninstall review-panel --scope project
```

Uninstall deletes only manifest-owned files. If install backed up an unmanaged file with `--force`, uninstall restores that backup. If an installed file changed after install, uninstall refuses to remove it so you can inspect the file manually.

Remove the optional skill:

```bash
codex-teams skill uninstall
```

State under `.codex-teams/` is project-local runtime data. It is ignored by default when the project appears to be a git worktree. Delete `.codex-teams/<team>/` when you no longer need the task board, journal, runs, or artifacts.
