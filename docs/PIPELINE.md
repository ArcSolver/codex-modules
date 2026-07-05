# 모듈화 파이프라인

## 역할 분담

- 오케스트레이터: Claude Code가 단계 설계, 서브 에이전트 프롬프트 작성, 결과 판정, 최종 통합을 맡는다.
- 워커: `codex exec` 서브 에이전트가 분석, 코드 작성처럼 판단이 필요한 작업을 수행한다.
- **결정적 작업은 워커에게 주지 않는다.** 클론, 의존성 설치, 빌드, verify 실행, git 조작, 해시 검사는 오케스트레이터가 직접 bash로 수행한다.

## 단계별 담당과 effort

xhigh는 분석에만 쓴다. 나머지 단계에 xhigh를 쓰면 추론 꼬리에서 수 분을 낭비한다 (1차 루프 실측).

| 단계 | 담당 | effort |
| --- | --- | --- |
| 1. Clone | 오케스트레이터 (bash) | — |
| 2. Feature Mapping | 워커 | `xhigh` — 분석 품질이 이후 전 단계를 결정 |
| 3. Abstraction Plan | 워커(2단계에 포함) + 오케스트레이터 리뷰 게이트 | `xhigh` |
| 4. Copy-First Extraction | 워커 | `high` — 좋은 분석 리포트가 있으면 추론보다 실행에 가까움 |
| 5. Verification | **오케스트레이터 직접** (`scripts/verify-module.sh`) | — |
| 6. Finalize | 오케스트레이터 | — |

스캐폴드·문서 작성 같은 보일러플레이트는 워커를 띄우지 않고 오케스트레이터가 직접 쓴다. 위임 오버헤드가 작업 자체보다 크다.

## 워커 운영 규칙

- **실행 형태**: `codex exec --cd <repo> -m gpt-5.5 -c model_reasoning_effort=<effort> - < .work/prompts/<단계>.md > .work/logs/<단계>.log 2>&1` 를 백그라운드로 띄운다. 프롬프트 템플릿은 `.work/templates/`에 있다.
- **공통 규칙은 프롬프트에 반복하지 않는다.** `codex exec`는 이 레포의 `AGENTS.md`를 자동으로 읽는다. 불변 규칙(샌드박스 강제, 클론 읽기 전용, artifact-first 등)은 AGENTS.md의 "워커 공통 규칙"에 있고, 단계 프롬프트에는 해당 단계의 델타만 쓴다.
- **artifact-first**: 워커는 결과를 최종 메시지가 아니라 파일로 남긴다(분석 → `.work/analysis/`, 코드 → `modules/`). 산출물이 파일에 있으면 워커를 중간에 죽여도 손실이 거의 없다.
- **진행 상태 신호**: 워커는 마일스톤마다 `.work/status/<단계>.json`을 갱신한다 (`{"stage": "...", "milestone": "...", "done": false}`). 오케스트레이터는 로그 크기가 아니라 이 파일로 진행률을 점검하고 사용자에게 중간 보고한다.
- **스톨 타임아웃**: 마지막 파일 쓰기(status 포함) 이후 **3분간 무활동이면 오케스트레이터가 워커를 kill하고 남은 작업을 인수한다.** 산출물은 파일에 있으므로 kill 비용은 낮다. 기다리지 말 것.

## 검증 이원화 (5단계 세부)

워커는 verify 스크립트를 **작성**까지만 하고, **실행·판정은 오케스트레이터**가 한다. verify는 결정적 bash라 LLM이 돌릴 이유가 없고, 실행 주체를 분리하면 워커 환경 잔여물(예: node_modules 미설치) 때문에 생기는 거짓 실패가 몇 초 만에 잡힌다.

오케스트레이터 표준 검증 시퀀스는 `scripts/verify-module.sh <module-dir>`:

1. 클린 설치(`npm install`) + 빌드
2. 모듈 자체 `verify/` 스크립트 실행 (exit 0)
3. 실기기 행동 검증: 샌드박스 `CODEX_HOME`에 등록 후 `codex debug models`에서 주입 슬러그가 `visibility: list`로 렌더링되는지 확인
4. 롤백 후 슬러그 소멸 확인
5. 실제 `~/.codex` 해시 가드 — 검증 전후 `config.toml` 불변 확인. `models_cache.json` 해시가 변했다면 내용으로 판별(상주 Codex 앱의 TTL 자동 갱신일 수 있음 — 커스텀 엔트리/expired wrapper 흔적이 없으면 무관)

## 단계 정의

### 1. Clone

| 항목 | 내용 |
| --- | --- |
| 입력 | 후보 오픈소스 레포 URL, 대상 기능 가설 |
| 작업 내용 | `.work/clones/<repo>`에 shallow clone하고 라이선스 파일과 패키지 구조를 확인한다. |
| 산출물 | 로컬 클론, 라이선스 확인 메모 |
| Definition of Done | 클론 완료 + 라이선스 확인 |

### 2. Feature Mapping (+ 3. Abstraction Plan)

| 항목 | 내용 |
| --- | --- |
| 입력 | 클론된 레포, 대상 기능 설명 |
| 작업 내용 | 대상 기능의 파일/함수 단위 인벤토리, 의존성 그래프, 리스크, 권장 모듈 표면(API/CLI/안전 동작/롤백)을 작성한다. |
| 산출물 | `.work/analysis/<module>.md` |
| Definition of Done | 최소 집합이 함수 수준으로 특정되고, 오케스트레이터가 리포트를 리뷰해 모듈 표면을 확정함 (리뷰 게이트) |

### 4. Copy-First Extraction

| 항목 | 내용 |
| --- | --- |
| 입력 | 원본 코드, 확정된 분석 리포트, `docs/MODULE_SPEC.md` |
| 작업 내용 | 원본 코드를 우선 복사하고 모듈 경계에 맞게 최소 수정하여 `modules/<name>/`에 배치한다. verify 스크립트도 여기서 작성한다(실행은 5단계에서 오케스트레이터가). |
| 산출물 | 독립 npm 패키지 형태의 `modules/<name>/` |
| Definition of Done | 빌드/타입체크 통과 |

### 5. Verification

| 항목 | 내용 |
| --- | --- |
| 입력 | 추출된 모듈 |
| 작업 내용 | 오케스트레이터가 `scripts/verify-module.sh`로 위의 표준 시퀀스를 실행하고, 결과를 `.work/analysis/<module>-verification.md`에 기록한다. |
| 산출물 | 검증 리포트 |
| Definition of Done | 전 체크 PASS + 실제 `~/.codex` 무결성 확인 |

### 6. Finalize

| 항목 | 내용 |
| --- | --- |
| 입력 | 검증된 모듈, 모듈 README, 루트 README |
| 작업 내용 | 문서를 정리하고 루트 README의 모듈 테이블을 갱신하고 커밋한다. 요청이 있을 때만 npm publish를 수행한다. |
| 산출물 | 신규 사용자가 따라 할 수 있는 모듈 문서, 갱신된 루트 README, 커밋 |
| Definition of Done | 신규 사용자가 모듈 README만으로 사용 가능 |
