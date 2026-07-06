<p align="right">English | <a href="README.ko.md">한국어</a></p>

# @codex-modules/scheduler

`codex-scheduler` stores scheduled local jobs and runs them on demand from a user-level tick command. It is dry-run by default: `tick` and `run` do not execute scripts or Codex unless `--execute` is provided, and Codex jobs additionally require `--allow-codex`.

## install

```bash
npm install -g @codex-modules/scheduler
```

Or from source:

```bash
npm install
npm run build
```

The default store is `~/.codex-modules/scheduler/`. Override it with `--store-dir`, API `storeDir`, or `CODEX_SCHEDULER_HOME`.

## usage

Create a Codex-backed job:

```bash
codex-scheduler create --schedule "every 30m" --prompt "Summarize repo health" --cwd "$PWD"
```

List and dry-run due work:

```bash
codex-scheduler list
codex-scheduler tick --now 2026-07-06T09:00:00 --json
```

Execute due work:

```bash
codex-scheduler tick --execute --allow-codex
```

Manual run:

```bash
codex-scheduler run <job-id> --execute --allow-codex
```

Install planning is dry-run unless `--write` is present:

```bash
codex-scheduler install-tick --interval-min 5
codex-scheduler install-tick --interval-min 5 --execute --allow-codex --write
```

## schedules

Supported schedule inputs are:

- `30m`, `2h`, `1d` for one-shot runs relative to creation time.
- `every 30m`, `every 2h` for intervals.
- ISO timestamps such as `2026-07-06T14:00:00` or `2026-07-06T14:00:00+09:00`.
- Five-field local cron: `minute hour day-of-month month day-of-week`.

Cron supports numbers, `*`, lists, ranges, and steps only. Aliases such as `@daily`, names such as `MON`, six-field cron, seconds, years, `L`, `W`, `#`, and `?` are rejected.

The module uses the host local timezone and no timezone database dependency. Spring-forward local times can normalize to the next valid JavaScript `Date`. Fall-back repeated wall-clock hours are guarded by persisted `nextRunAt` and job claims.

## safety

Codex argv is fixed to the safe lane:

```text
codex exec --skip-git-repo-check [-C <cwd>] -s read-only [-m <model>] [-c model_reasoning_effort=<effort>] -o <output.md> --json --ephemeral <prompt>
```

`-a`, `--ask-for-approval`, `--dangerously-*`, `danger-full-access`, and arbitrary `-c` passthrough are not generated or accepted. Child stdin is connected to the platform dev-null device through the stdio fd array.

Scripts are user-authored local automation, not a sandbox. Script paths must stay under the scheduler script root, cwd must be an absolute real directory outside common secret/config locations, and env is filtered before spawning.

The credential guard blocks obvious exfiltration targets such as `auth.json`, `$CODEX_HOME`, `~/.codex`, common API token env names, bearer tokens, x-api-key headers, access tokens, private keys, and direct shell/network combinations involving secret files. Output redaction is best-effort and fail-closed.

## blueprints

```bash
codex-scheduler create --blueprint custom-reminder --slot message="Pay rent" --slot time=08:30 --slot recurrence=daily
codex-scheduler create --blueprint repo-health-check --slot repo="$PWD" --slot recurrence=weekdays
```

Available blueprints are `custom-reminder` and `repo-health-check`.

## Build notes

- Cron next-run search is bounded to five years and advances minute by minute rather than using a precomputed candidate-set optimizer. This keeps the implementation dependency-free while preserving the contract's bounded failure behavior.

## Attribution

Inspired by NousResearch/hermes-agent (MIT): https://github.com/NousResearch/hermes-agent
