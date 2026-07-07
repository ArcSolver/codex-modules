<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/teams

`codex-teams`는 `team.json`을 Codex agent TOML, 리더 지시문, 프로젝트 로컬 팀 상태로 바꾸는 CLI입니다.

멀티 에이전트 실행 엔진은 Codex native stable `multi_agent_v1.spawn_agent`를 리더 세션 안에서 사용합니다. 이 패키지는 엔진을 다시 만들지 않고, 팀 정의, 안전한 install/uninstall, task lease, journal, dry-run 기본 headless runner를 관리합니다.

## 설치

```bash
npm install -g @codex-modules/teams
```

또는 source에서:

```bash
npm install
npm run build
```

이 패키지의 CLI를 바로 실행하려면:

```bash
node dist/cli.js doctor
```

global 설치나 npm linking 후에는:

```bash
codex-teams doctor
```

## 사용법

starter team을 만듭니다:

```bash
codex-teams init --preset review-panel --out team.json
codex-teams validate team.json
```

팀을 Codex home에 설치합니다:

```bash
codex-teams install team.json
```

기본값은 `$CODEX_HOME/agents/<team>-<member>.toml`을 쓰고 `$CODEX_HOME/agents/.codex-teams-manifest.json`에 소유권을 기록합니다. sandbox나 다른 Codex home을 쓰려면 `--codex-home <dir>`를 넘기세요.

Project scope 설치는 명시적으로 선택합니다:

```bash
codex-teams install team.json --scope project
```

Project scope는 `<cwd>/.codex/agents/`에 쓰고 trust 경고를 출력합니다. `config.toml`을 편집하거나 프로젝트를 trusted로 등록하지 않습니다.

리더 프롬프트를 생성합니다:

```bash
codex-teams leader-prompt team.json --goal "Review this change for security and correctness"
```

프로젝트 내구 상태를 시작합니다:

```bash
codex-teams state init review-panel --goal "Review this change"
codex-teams task add review-panel --title "Security review"
codex-teams task claim review-panel task-001 --actor security
codex-teams note add review-panel --actor leader --text "Security and correctness can run in parallel"
```

`run`은 기본적으로 dry-run입니다:

```bash
codex-teams run team.json --goal "Review this change"
```

실제 `codex exec` 실행은 두 opt-in이 모두 필요합니다:

```bash
codex-teams run team.json --goal "Review this change" --execute --allow-codex
```

실행 runner는 기본적으로 `codex exec -s workspace-write --skip-git-repo-check --json --ephemeral`을 사용하고 run artifact를 `.codex-teams/<team>/runs/` 아래에 남깁니다. runner는 `read-only` 또는 `workspace-write` sandbox만 허용하고, danger-access flag를 전달하지 않으며, 조립된 prompt를 `codex exec`의 단일 positional 인자로만 넘깁니다.

`--codex-home <dir>`로 sandbox 또는 다른 Codex home을 지정할 수 있고, `--state-dir <dir>`로 기본 `.codex-teams` 밖에 team state를 쓸 수 있습니다.

선택적 Codex skill을 설치합니다:

```bash
codex-teams skill install
```

기존 unmanaged skill file을 backup 후 교체하려면 `codex-teams skill install --force`를 사용합니다.

## 동작 방식

`team.json`은 team name, defaults, 2명에서 8명 사이의 members를 정의합니다. Member name은 `<team>-<member>` 형식의 Codex agent type이 됩니다.

Install은 각 member를 다음 필드가 있는 TOML로 렌더합니다:

- `name`
- `description`
- `model`
- `sandbox_mode`
- `nickname_candidates`
- `developer_instructions`

모든 TOML string은 basic string으로 렌더되어 따옴표, 백슬래시, 개행, TOML 제어문자가 escape됩니다. `nickname_candidates`는 string array로 렌더됩니다.

기존 unmanaged file은 `--force` 없이는 절대 덮어쓰지 않습니다. `--force`를 사용한 overwrite는 먼저 backup을 만듭니다. Uninstall은 선택한 target root의 manifest에 기록된 파일만 건드립니다.

프로젝트 상태는 다음 위치에 있습니다:

```text
.codex-teams/<team>/
  state.json
  tasks.json
  journal.jsonl
  artifacts/<member>/
  runs/
  locks/
```

`state.json`과 `tasks.json`은 mkdir lock 안에서 atomic write로 저장됩니다. `journal.jsonl`은 같은 lock 안에서 append-only로 추가됩니다. Task claim은 lease를 사용하며, 만료된 claim은 `task claim`과 `task list --reclaim`에서 회수됩니다. 결정론적 테스트에는 `CODEX_TEAMS_NOW`로 시간을 override할 수 있습니다.

상태 CLI는 리더 또는 사람이 호출하는 표면입니다. 멤버는 마지막 `TEAM-RESULT: <one-line summary>` 줄로 보고합니다. Workspace-write 멤버는 선택적으로 artifact를 남길 수 있지만, canonical 결과 채널은 final message입니다.

`doctor`는 Codex binary, version, native feature state, model catalog availability, write access, installed teams를 user/project scope로 나눠 보고합니다. 다른 team state directory를 확인하려면 `--state-dir <dir>`를 사용합니다. 건강한 native workflow에는 `multi_agent`가 stable and enabled여야 합니다. `enable_fanout`과 `multi_agent_v2`는 under-development surface로만 보고합니다.

이 package는 runtime dependency가 없습니다. package root는 team parsing, install/uninstall, doctor, prompt/run planning, durable state/task/note operation을 위한 지원 대상 high-level helper만 export합니다. Programmatic API에는 harness adapter 실험용 `HarnessProfile`과 `nativeV1Harness`도 포함됩니다. 이 harness export는 experimental이며 두 번째 adapter가 생기기 전까지 semver 밖에서 변경될 수 있습니다.

## Attribution

No third-party code is included; the state protocol is an original clean-room design.

## 제거와 롤백

설치된 team을 제거합니다:

```bash
codex-teams uninstall review-panel
```

sandbox 또는 project scope를 썼다면 install 때와 같은 target root를 지정합니다:

```bash
codex-teams uninstall review-panel --codex-home /tmp/codex-home
codex-teams uninstall review-panel --scope project
```

Uninstall은 manifest-owned file만 삭제합니다. `--force` install이 unmanaged file을 backup했다면 uninstall 때 그 backup을 복원합니다. 설치된 파일이 install 이후 바뀌었다면, 수동 확인을 위해 uninstall이 삭제를 거부합니다.

선택적 skill 제거:

```bash
codex-teams skill uninstall
```

`.codex-teams/` 아래 상태는 project-local runtime data입니다. 프로젝트가 git worktree로 보이면 기본적으로 ignore됩니다. task board, journal, runs, artifacts가 더 필요 없으면 `.codex-teams/<team>/`을 삭제하세요.
