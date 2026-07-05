# 모듈화 파이프라인

## 역할 분담

- 오케스트레이터: Claude Code가 단계 설계, 서브 에이전트 프롬프트 작성, 결과 판정, 최종 통합을 맡는다.
- 워커: `codex exec` 서브 에이전트가 분석, 코드 작성, 검증 실행처럼 분리 가능한 작업을 수행한다.

## 1. Clone

| 항목 | 내용 |
| --- | --- |
| 입력 | 후보 오픈소스 레포 URL, 대상 기능 가설 |
| 작업 내용 | `.work/clones/<repo>`에 shallow clone하고 라이선스 파일과 패키지 구조를 확인한다. |
| 산출물 | 로컬 클론, 라이선스 확인 메모 |
| Definition of Done | 클론 완료 + 라이선스 확인 |

## 2. Feature Mapping

| 항목 | 내용 |
| --- | --- |
| 입력 | 클론된 레포, 대상 기능 설명 |
| 작업 내용 | 대상 기능의 파일/함수 단위 인벤토리와 의존성 그래프를 작성한다. |
| 산출물 | `.work/analysis/<module>.md` |
| Definition of Done | 독립 모듈에 필요한 최소 집합이 함수 수준으로 특정됨 |

## 3. Abstraction Plan

| 항목 | 내용 |
| --- | --- |
| 입력 | 기능 분석 리포트, `docs/MODULE_SPEC.md` |
| 작업 내용 | 모듈의 API, CLI 표면, 입력/출력, 안전 동작, 롤백 경로를 설계한다. |
| 산출물 | `.work/analysis/<module>.md`에 확정된 모듈 표면 |
| Definition of Done | 리포트에 모듈 표면이 확정됨 |

## 4. Copy-First Extraction

| 항목 | 내용 |
| --- | --- |
| 입력 | 원본 코드, 추상화 계획, 모듈 규칙 |
| 작업 내용 | 원본 코드를 우선 복사하고 모듈 경계에 맞게 최소 수정하여 `modules/<name>/`에 배치한다. |
| 산출물 | 독립 npm 패키지 형태의 `modules/<name>/` |
| Definition of Done | 빌드/타입체크 통과 |

## 5. Verification

| 항목 | 내용 |
| --- | --- |
| 입력 | 추출된 모듈, 의도한 사용자 시나리오 |
| 작업 내용 | `verify/` 스크립트로 샌드박스 `CODEX_HOME`을 사용해 실제 의도 부합을 검증한다. |
| 산출물 | 실행 가능한 검증 스크립트와 결과 로그 |
| Definition of Done | 검증 스크립트 exit 0 |

## 6. Finalize

| 항목 | 내용 |
| --- | --- |
| 입력 | 검증된 모듈, 모듈 README, 루트 README |
| 작업 내용 | 문서를 정리하고 루트 README의 모듈 테이블을 갱신한다. 요청이 있을 때만 npm publish를 수행한다. |
| 산출물 | 신규 사용자가 따라 할 수 있는 모듈 문서, 갱신된 루트 README |
| Definition of Done | 신규 사용자가 모듈 README만으로 사용 가능 |
