# 모듈화 파이프라인

한 루프는 "레포에서 기능 하나를 독립 모듈로 추출"이다. 게이트가 있는 실질 단계는 셋이다:

클론(1커맨드) → **① 분석** → 리뷰 게이트 → **② 구현** → **③ 검증·마무리**

대상 레포가 정해지지 않은 신규 표면은 ① 앞에 **⓪ 레퍼런스 조사**를 둔다: 토픽×앵글(web/github)로 워커를 병렬 발사(템플릿 `1-research.md`) → 오케스트레이터가 리뷰 게이트에서 레퍼런스 확정 → **핵심 가정은 샌드박스 실측으로 검증 후** ②로 넘어간다(문서·소스보다 로컬 바이너리 실측이 우선한다 — 실례: hooks는 문서상 stable이지만 0.139.0 exec에서 불발).

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
- **스톨 타임아웃**: 워커 산출물·로그의 마지막 쓰기 이후 **3분간(조사·빌드처럼 추론 꼬리가 긴 단계는 5분) 무활동이면 오케스트레이터가 워커를 kill하고 남은 작업을 인수한다.** artifact-first 덕분에 kill 비용은 낮다. 기다리지 말 것. 인수는 "남은 조각만 좁힌 finish 프롬프트로 재발사"가 가장 싸다(전면 재실행 금지).
- **프롬프트에 증분 쓰기를 강제한다**: "시작 직후 골격부터 쓰고 발견/구현 즉시 append" 문구가 없으면 워커가 결과를 머리에 들고 추론 꼬리에서 스톨 오탐으로 죽는다.
- `codex exec` 자동화 호출은 항상 stdin을 `< /dev/null`로 닫는다(파이프 stdin이면 EOF 대기 행업).
- 루프 종료 시 `.work/prompts/`의 일회성 프롬프트는 삭제한다(템플릿만 유지).

## 표준 검증 시퀀스 (`scripts/verify-module.sh <module-dir>`)

버전 기준: 검증은 PATH의 codex가 아니라 **핀된 테스트베드 바이너리**로 한다 — `codex-versions.toml`(min=지원 하한, latest=검증 완료 최신)을 `scripts/codex-testbed.sh`가 받아 `.work/testbed/`에 캐시하고, `CODEX_BIN`으로 주입하면 verify-module.sh가 PATH shim을 깐다. 전체 매트릭스는 `scripts/verify-all.sh`. **latest 핀 bump → verify-all 실패 = 드리프트 발견**이 감지 루틴이다.

auth 2레인: 기본 verify.sh는 오프라인(샌드박스 CODEX_HOME, 토큰 0). 라이브 검증(behavioral.sh)은 `RUN_LIVE=1` 옵트인으로, 실제 홈을 auth 용도로만 빌린다 — `--ignore-user-config --ephemeral` + 설정은 `-c` 주입(auth.json은 절대 복사·symlink하지 않는다: 원자적 재작성이 symlink를 일반 파일로 교체한다).

1. 클린 설치(`npm install`) + 빌드
2. `verify/verify.sh` — 샌드박스 `CODEX_HOME` 기반 기능 검증 (exit 0)
3. `verify/behavioral.sh` (있으면) — 실기기 검증: 샌드박스 등록 후 `codex debug models`에 주입 슬러그가 `visibility: list`로 렌더링되는지, 롤백 후 소멸하는지 확인
4. 실제 `~/.codex` 무결성 가드 — `config.toml` 해시 불변 확인. `models_cache.json`은 해시 대신 내용 검사(expired wrapper·주입 슬러그 부재) — 상주 Codex 앱의 TTL 자동 갱신 때문에 해시는 오탐한다.
