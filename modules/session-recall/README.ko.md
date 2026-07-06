<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/session-recall

`codex-session-recall`은 Codex transcript JSONL을 module-owned SQLite database로 색인한 뒤, FTS5, lineage-aware dedupe, anchored windows, read/around view로 과거 session을 검색합니다.

`$CODEX_HOME`에는 절대 쓰지 않습니다. Sync는 명시적입니다. package를 설치해도 transcript를 색인하거나 Codex hook을 추가하지 않습니다.

## 설치

```bash
npm install -g @codex-modules/session-recall
```

또는 source에서:

```bash
npm install
npm run build
```

이 package는 native runtime dependency인 `better-sqlite3`를 사용합니다. 설치에 실패하면 Node version이 `>=24`를 만족하는지, 그리고 platform에서 prebuilt package를 설치하거나 native addon을 compile할 수 있는지 확인하세요.

## 사용법

현재 Codex session 색인:

```bash
codex-session-recall sync
```

sandboxed input root와 state directory 사용:

```bash
codex-session-recall sync --codex-home /tmp/codex-home --state-dir /tmp/session-recall
```

검색:

```bash
codex-session-recall search "SQLite FTS5"
codex-session-recall search "SQLite FTS5" --json
```

session 읽기:

```bash
codex-session-recall read 019...
codex-session-recall around 019... '#18'
```

## 명령어

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

기본적으로 `sync`는 `$CODEX_HOME/sessions/**/rollout-*.jsonl`을 scan합니다. Archived session은 `--include-archived`를 전달하지 않는 한 제외됩니다.

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

Search는 session-level result를 반환합니다. 하나의 lineage 안에서는 기본적으로 가장 잘 matching되는 session만 반환됩니다.

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

`msg-ref`는 stable session-local message sequence입니다. 예: `18` 또는 `#18`. Debug recovery를 위해 `line:<line_no>`도 허용됩니다.

## 상태와 privacy

Default paths:

```text
codexHome = CODEX_HOME or ~/.codex
stateDir = CODEX_SESSION_RECALL_STATE_DIR or ~/.codex-modules/session-recall
dbPath = stateDir/state.sqlite
```

SQLite database는 파생된 local search index입니다. user prompt, assistant message, tool call, tool output을 포함할 수 있으며, complete source of truth로 보존되는 것이 아니라 indexing을 위해 capped됩니다. 다음으로 삭제할 수 있습니다:

```bash
rm -rf ~/.codex-modules/session-recall
```

Human output과 `--json` output은 기본적으로 rollout absolute path를 생략합니다. index provenance를 inspect해야 할 때만 `--debug-paths`를 전달하세요.

이 tool은 과거 Codex transcript를 검색합니다. 현재 filesystem, web, email, app, PR, issue state의 증거가 아닙니다. freshness가 중요할 때는 현재 source를 직접 검증하세요.

## Attribution

NousResearch/hermes-agent (MIT)에서 영감을 받았습니다: https://github.com/NousResearch/hermes-agent
