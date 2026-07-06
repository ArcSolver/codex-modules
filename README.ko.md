<p align="right"><a href="README.md">English</a> | 한국어</p>

# codex-modules

공식 OpenAI Codex 앱/CLI를 진짜 내 것으로 만들어주는, 작고 독립적인 모듈 모음.

각 모듈은 독립적으로 설치·실행되고 되돌릴 수 있습니다. 모듈을 설치해 실행하고, 원하는 동작이 더해진 공식 Codex 앱/CLI를 그대로 계속 사용하세요.

## 무엇인가요

codex-modules는 공식 OpenAI Codex 앱/CLI를 포크하지 않고 확장·커스터마이징할 수 있게 해주는 프로덕션 품질 모듈 컬렉션입니다.

## 모듈

| 모듈 | npm | 하는 일 | 상태 |
| --- | --- | --- | --- |
| `custom-models` | `@codex-modules/custom-models` | Responses API 호환 모델을 Codex 앱 모델 선택기에 추가 | alpha |
| `config-kit` | `@codex-modules/config-kit` | Codex 설정 표면 안전 편집 툴킷: 원자적 쓰기, 백업, 관리 블록, 기능 감지, app-server RPC | alpha |
| `hooks` | `@codex-modules/hooks` | Codex 라이프사이클 훅 설치·신뢰·관리 — 파일 기반 또는 호출 단위 세션 플래그 | alpha |
| `skills` | `@codex-modules/skills` | 3개 스킬 루트 전체에 걸친 Codex 스킬 설치·검증·변환·관리 | alpha |
| `mcp-manager` | `@codex-modules/mcp-manager` | 충돌 감지, 백업, 고급 키 패치, 롤백을 갖춘 MCP 서버 등록 | alpha |
| `subagents` | `@codex-modules/subagents` | 스톨 감지, 타임아웃, 재개를 갖춘 병렬 `codex exec` 서브 에이전트 실행 | alpha |
| `session-recall` | `@codex-modules/session-recall` | 과거 Codex 세션을 로컬에서 검색: transcript 위 SQLite FTS 색인 + 앵커 컨텍스트 윈도우 | alpha |
| `lsp-sidecar` | `@codex-modules/lsp-sidecar` | MCP로 Codex에 코드 지능 부여: LSP 진단, 정의 이동, hover, 워크스페이스 심볼 | alpha |
| `scheduler` | `@codex-modules/scheduler` | cron/interval 파싱, wake gate, dry-run 기본값을 갖춘 안전한 옵트인 `codex exec` 예약 실행 | alpha |
| `teams` | `@codex-modules/teams` | 커스텀 에이전트 팀을 데이터로 선언해 Codex의 stable 멀티 에이전트 도구 위에서 실행 — 내구 태스크 상태와 롤백 안전 설치 제공 | alpha |

## 시작하기

hooks 모듈을 설치하고 샌드박스 Codex 홈에서 실험해보세요. 아래 예시는 실제
hookset을 만들어 임시 `$CODEX_HOME`에 적용하고, 진짜 Codex 설정은 건드리지
않은 채 상태를 확인합니다.

```bash
npm install -g @codex-modules/hooks

SANDBOX_CODEX_HOME="$(mktemp -d)"
HOOK_SCRIPT="$SANDBOX_CODEX_HOME/lifecycle-notify.sh"

cat > "$HOOK_SCRIPT" <<'SH'
#!/usr/bin/env bash
echo "codex lifecycle hook fired" >> "$CODEX_HOME/hook.log"
SH
chmod +x "$HOOK_SCRIPT"

cat > hookset.json <<JSON
{
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        {
          "type": "command",
          "command": "$HOOK_SCRIPT",
          "timeout": 5,
          "statusMessage": "Starting Codex session"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "$HOOK_SCRIPT",
          "timeout": 5
        }
      ]
    }
  ]
}
JSON

codex-hooks plan --hooks hookset.json --codex-home "$SANDBOX_CODEX_HOME"
codex-hooks apply --hooks hookset.json --codex-home "$SANDBOX_CODEX_HOME"
codex-hooks status --codex-home "$SANDBOX_CODEX_HOME"
```

각 모듈에는 설치·사용법·검증·롤백 안내가 담긴 자체 README가 있습니다.

`modules/<name>/` 아래의 모듈 README부터 시작하세요.

모듈은 조합해서 쓸 수도 있습니다. 예를 들어 `subagents`로 읽기 전용
`codex exec` 조사 두 개를 병렬 실행하면서, 그 실행에 쓰이는 샌드박스 Codex
홈의 라이프사이클 알림은 `hooks`가 관리하게 할 수 있습니다:

```bash
cat > tasks.jsonl <<'JSONL'
{"id":"entry-points","prompt":"Inspect this repo and summarize likely entry points. Do not edit files.","cwd":".","sandbox":"read-only"}
{"id":"test-gaps","prompt":"Inspect this repo and summarize test coverage gaps. Do not edit files.","cwd":".","sandbox":"read-only"}
JSONL

codex-subagents run --tasks tasks.jsonl --out .work/subagents/quick-start --parallel 2 --timeout 600 --stall 180 --codex-home "$SANDBOX_CODEX_HOME"
```

## 설계 원칙

- 독립성: 각 모듈은 독립적으로 설치·실행됩니다.
- 가역성: 제거와 롤백 경로가 모듈 계약의 일부입니다.
- 기본 안전: 모듈은 `$CODEX_HOME`을 손상시키지 않아야 합니다.
- 검증됨: 각 모듈은 의도대로 동작함을 증명하는 실행 가능한 체크를 포함합니다.

## 라이선스

MIT
