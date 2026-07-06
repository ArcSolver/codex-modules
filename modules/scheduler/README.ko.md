<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/scheduler

`codex-scheduler`는 scheduled local job을 저장하고 user-level tick command에서 필요할 때 실행합니다. 기본값은 dry-run입니다. `tick`과 `run`은 `--execute`가 제공되지 않으면 script나 Codex를 실행하지 않으며, Codex job에는 추가로 `--allow-codex`가 필요합니다.

## 설치

```bash
npm install -g @codex-modules/scheduler
```

또는 source에서:

```bash
npm install
npm run build
```

기본 store는 `~/.codex-modules/scheduler/`입니다. `--store-dir`, API `storeDir`, 또는 `CODEX_SCHEDULER_HOME`으로 override할 수 있습니다.

## 사용법

Codex-backed job 생성:

```bash
codex-scheduler create --schedule "every 30m" --prompt "Summarize repo health" --cwd "$PWD"
```

due work 목록 보기 및 dry-run:

```bash
codex-scheduler list
codex-scheduler tick --now 2026-07-06T09:00:00 --json
```

due work 실행:

```bash
codex-scheduler tick --execute --allow-codex
```

Manual run:

```bash
codex-scheduler run <job-id> --execute --allow-codex
```

install planning은 `--write`가 없으면 dry-run입니다:

```bash
codex-scheduler install-tick --interval-min 5
codex-scheduler install-tick --interval-min 5 --execute --allow-codex --write
```

## schedule

지원되는 schedule input은 다음과 같습니다:

- `30m`, `2h`, `1d`: creation time 기준 one-shot run.
- `every 30m`, `every 2h`: interval.
- `2026-07-06T14:00:00` 또는 `2026-07-06T14:00:00+09:00` 같은 ISO timestamp.
- Five-field local cron: `minute hour day-of-month month day-of-week`.

Cron은 숫자, `*`, list, range, step만 지원합니다. `@daily` 같은 alias, `MON` 같은 name, six-field cron, seconds, years, `L`, `W`, `#`, `?`는 거부됩니다.

이 module은 host local timezone을 사용하며 timezone database dependency는 없습니다. Spring-forward local time은 다음 valid JavaScript `Date`로 normalize될 수 있습니다. Fall-back으로 반복되는 wall-clock hour는 persisted `nextRunAt`과 job claim으로 보호됩니다.

## 안전

Codex argv는 safe lane으로 고정됩니다:

```text
codex exec --skip-git-repo-check [-C <cwd>] -s read-only [-m <model>] [-c model_reasoning_effort=<effort>] -o <output.md> --json --ephemeral <prompt>
```

`-a`, `--ask-for-approval`, `--dangerously-*`, `danger-full-access`, 임의의 `-c` passthrough는 생성되거나 허용되지 않습니다. Child stdin은 stdio fd array를 통해 platform dev-null device에 연결됩니다.

Script는 user-authored local automation이지 sandbox가 아닙니다. Script path는 scheduler script root 아래에 있어야 하고, cwd는 일반적인 secret/config location 밖에 있는 absolute real directory여야 하며, env는 spawn 전에 filtering됩니다.

credential guard는 `auth.json`, `$CODEX_HOME`, `~/.codex`, 일반적인 API token env name, bearer token, x-api-key header, access token, private key, secret file과 관련된 direct shell/network combination 같은 명백한 exfiltration target을 차단합니다. Output redaction은 best-effort이며 fail-closed입니다.

## blueprint

```bash
codex-scheduler create --blueprint custom-reminder --slot message="Pay rent" --slot time=08:30 --slot recurrence=daily
codex-scheduler create --blueprint repo-health-check --slot repo="$PWD" --slot recurrence=weekdays
```

사용 가능한 blueprint는 `custom-reminder`와 `repo-health-check`입니다.

## 빌드 참고

- Cron next-run search는 5년으로 bounded되어 있으며 precomputed candidate-set optimizer를 사용하지 않고 minute 단위로 advance합니다. 이렇게 하면 contract의 bounded failure behavior를 보존하면서 implementation을 dependency-free로 유지할 수 있습니다.

## Attribution

NousResearch/hermes-agent (MIT)에서 영감을 받았습니다: https://github.com/NousResearch/hermes-agent
