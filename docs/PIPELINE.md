# 모듈화 파이프라인

한 루프는 "레포에서 기능 하나를 독립 모듈로 추출"이다. 게이트가 있는 실질 단계는 셋이다:

클론(1커맨드) → **① 분석** → 리뷰 게이트 → **② 구현** → **③ 검증·마무리**

## 역할 분담

- 오케스트레이터(Claude Code): 단계 설계, 워커 프롬프트 작성, 리뷰 게이트 판정, 검증 실행, 커밋.
- 워커(`codex exec` 서브 에이전트): 판단이 필요한 작업만 — 분석과 코드 작성.
- **결정적 작업은 워커에게 주지 않는다.** 클론, 의존성 설치, 빌드, verify 실행, git 조작, 해시 검사는 오케스트레이터가 직접 bash로 수행한다.
- 스캐폴드·문서 보일러플레이트도 오케스트레이터가 직접 쓴다. 위임 오버헤드가 작업 자체보다 크다.

## 단계 정의

| | ① 분석 | ② 구현 | ③ 검증·마무리 |
| --- | --- | --- | --- |
| 담당 | 워커 `xhigh` | 워커 `high` | 오케스트레이터 |
| 입력 | `.work/clones/<repo>` (shallow clone + 라이선스 확인 선행), 대상 기능 설명, 진입점 힌트 | 오케스트레이터가 확정한 분석 리포트, `docs/MODULE_SPEC.md` | 완성된 `modules/<name>/` |
| 작업 | 파일/함수 단위 인벤토리, 의존성 그래프, 리스크, 권장 모듈 표면(API/CLI/롤백/MVP 컷) | copy-first 추출 → `modules/<name>/`. verify 스크립트도 작성한다(실행은 ③에서) | `scripts/verify-module.sh` 실행, 검증 리포트 작성, 루트 README 모듈 테이블 갱신, 커밋 |
| 산출물 | `.work/analysis/<module>.md` | 독립 npm 패키지 형태의 `modules/<name>/` | `.work/analysis/<module>-verification.md`, 커밋 |
| DoD | 최소 집합이 함수 수준으로 특정되고 **오케스트레이터가 리포트를 리뷰해 모듈 표면을 확정함(리뷰 게이트)** | 빌드/타입체크 통과 | 전 체크 PASS + 실제 `~/.codex` 무결성 확인 + 신규 사용자가 모듈 README만으로 사용 가능 |

effort 근거(1차 루프 실측): `xhigh`는 분석에서만 값을 한다. 구현·문서에 쓰면 추론 꼬리에서 수 분을 낭비한다.

npm publish는 사용자가 요청할 때만 수행한다.

## 워커 운영 규칙

- **실행 형태**: `codex exec --cd <repo> -m gpt-5.5 -c model_reasoning_effort=<effort> - < .work/prompts/<이름>.md > .work/logs/<이름>.log 2>&1` 를 백그라운드로 띄운다. 프롬프트 템플릿은 `.work/templates/`.
- **공통 규칙은 프롬프트에 반복하지 않는다.** `codex exec`는 이 레포의 `AGENTS.md`("워커 공통 규칙")를 자동으로 읽는다. 단계 프롬프트에는 해당 단계의 델타만 쓴다.
- **artifact-first**: 워커 산출물은 파일로 남는다. 워커를 중간에 죽여도 파일만으로 인수 가능해야 한다.
- **스톨 타임아웃**: 워커 산출물·로그의 마지막 쓰기 이후 **3분간 무활동이면 오케스트레이터가 워커를 kill하고 남은 작업을 인수한다.** artifact-first 덕분에 kill 비용은 낮다. 기다리지 말 것.
- 루프 종료 시 `.work/prompts/`의 일회성 프롬프트는 삭제한다(템플릿만 유지).

## 표준 검증 시퀀스 (`scripts/verify-module.sh <module-dir>`)

1. 클린 설치(`npm install`) + 빌드
2. `verify/verify.sh` — 샌드박스 `CODEX_HOME` 기반 기능 검증 (exit 0)
3. `verify/behavioral.sh` (있으면) — 실기기 검증: 샌드박스 등록 후 `codex debug models`에 주입 슬러그가 `visibility: list`로 렌더링되는지, 롤백 후 소멸하는지 확인
4. 실제 `~/.codex` 무결성 가드 — `config.toml` 해시 불변 확인. `models_cache.json`은 해시 대신 내용 검사(expired wrapper·주입 슬러그 부재) — 상주 Codex 앱의 TTL 자동 갱신 때문에 해시는 오탐한다.
