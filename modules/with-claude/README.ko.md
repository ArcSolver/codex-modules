<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/with-claude

`codex-with-claude`는 Codex custom provider용 personal localhost provider adapter입니다. 로컬에서 Responses 호환 endpoint를 열고, Codex가 `wire_api = "responses"`로 호출한 function-tool turn을 Claude Agent SDK 쪽으로 연결합니다.

이 adapter는 Codex tool을 직접 실행하지 않습니다. Claude가 tool call을 계획하면 adapter가 Codex `function_call` SSE를 내보내고, 승인과 실행은 Codex가 맡습니다. Codex가 돌려준 `function_call_output`만 active Claude turn으로 전달합니다.

## 설치

```bash
npm install -g @codex-modules/with-claude
```

또는 source에서:

```bash
npm install
npm run build
```

이 패키지의 CLI를 바로 실행하려면:

```bash
node dist/cli.js doctor --json
```

global 설치나 npm linking 후에는:

```bash
codex-with-claude doctor --json
```

## 사용법

localhost adapter를 시작합니다:

```bash
codex-with-claude serve
```

시작되면 stdout에 JSON 한 줄을 출력합니다:

```json
{"baseUrl":"http://127.0.0.1:47777/v1","providerId":"with_claude"}
```

명시적인 Codex home에 provider block을 설치합니다:

```bash
codex-with-claude install \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1
```

기본 동작은 provider block만 추가합니다. top-level Codex `model`이나 `model_provider`는 바꾸지 않습니다. 해당 Codex home의 기본 provider로 지정하려면:

```bash
codex-with-claude install \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1 \
  --set-default
```

설치되는 provider 설정은 다음 형식입니다:

```toml
[model_providers.with_claude]
name = "With Claude"
base_url = "http://127.0.0.1:47777/v1"
wire_api = "responses"
```

Serve 옵션:

```bash
codex-with-claude serve \
  --host 127.0.0.1 \
  --port 47777 \
  --model with-claude \
  --log-level info \
  --idle-ttl-ms 1800000 \
  --request-timeout-ms 90000 \
  --tool-result-ttl-ms 600000
```

`--unsafe-log-previews`는 명시적으로 켜야 합니다. 기본 로그에는 request body, tool output, raw Claude event를 남기지 않고 event metadata, 길이, hash만 기록합니다.

## 동작 방식

서버는 두 endpoint만 노출합니다:

- `GET /healthz`
- `POST /v1/responses`

기본 bind는 `127.0.0.1`입니다. non-local bind host는 거부합니다. browser-origin 요청, CORS preflight, JSON이 아닌 provider 요청, streaming이 아닌 provider 요청도 거부합니다.

각 Codex 요청은 turn-scoped Claude query 하나를 시작합니다. adapter는 Codex `instructions`와 `input`에서 prompt를 복구하고, 지원되는 Codex `function` tool만 conservative MCP tool로 변환한 뒤 Claude Agent SDK를 locked-down 옵션으로 시작합니다:

- `settingSources: []`
- `tools: []`
- in-process `codex_bridge` MCP server 하나
- `permissionMode: "dontAsk"`
- `allowedTools`는 생성된 `mcp__codex_bridge__<tool>` 이름으로 제한

지원되는 JSON Schema를 가진 Codex `function` tool만 Claude에 노출됩니다. `namespace`와 `web_search`는 Claude에 노출하지 않습니다. 지원하지 않는 schema는 fail-closed로 빠지고 Claude tool catalog에 들어가지 않습니다.

adapter는 Codex `thread-id`를 primary key로 쓰는 in-memory session registry를 둡니다. fallback은 `session-id`, `prompt_cache_key`, `x-client-request-id`, input hash 순서입니다. 같은 request id가 재시도되면 저장된 SSE transcript를 replay해서 새 Claude query를 만들지 않습니다.

Timeout과 Claude측 오류는 diagnostic `output_text`와 `response.completed`로 반환합니다. 이 adapter는 HTTP 429 또는 `response.failed`를 emit하지 않습니다.

## 진단

실행:

```bash
codex-with-claude doctor --json
```

sandbox Codex home과 함께:

```bash
codex-with-claude doctor --codex-home /tmp/codex-home --json
```

실행 중인 adapter까지 확인:

```bash
codex-with-claude doctor \
  --codex-home /tmp/codex-home \
  --base-url http://127.0.0.1:47777/v1 \
  --json
```

`doctor`는 Node, pinned runtime dependency, `ANTHROPIC_API_KEY` shadowing, 선택적 Codex provider config, 선택적 `/healthz`를 점검합니다. Codex home 경로를 명시하거나 `CODEX_HOME`을 해당 경로로 설정한 경우가 아니면 실제 `~/.codex`나 `~/.claude`는 inspect하지 않습니다.

`ANTHROPIC_API_KEY`가 있으면 `ALLOW_ANTHROPIC_API_KEY=1`도 설정한 경우에만 `serve`가 시작됩니다. 환경 key가 Claude Agent SDK 인증 경로를 바꾸는 상황을 fail-closed로 막기 위한 동작입니다.

## Attribution

이 패키지에는 third-party source code가 포함되지 않습니다.

Runtime dependencies:

- `@anthropic-ai/claude-agent-sdk` 0.3.202, package license file에 Anthropic이 게시한 license.
- `@anthropic-ai/sdk` 0.110.0, MIT.
- `@modelcontextprotocol/sdk` 1.29.0, MIT.
- `zod` 4.4.3, MIT.

## 제거와 롤백

install 때 사용한 같은 Codex home에서 provider를 제거합니다:

```bash
codex-with-claude uninstall --codex-home /tmp/codex-home
```

Install은 쓰기 전에 항상 backup을 만듭니다:

```text
<CODEX_HOME>/config.toml.codex-with-claude.<timestamp>.bak
```

설치 소유권은 다음 manifest에 기록합니다:

```text
<CODEX_HOME>/codex-modules/with-claude-install.json
```

`uninstall`은 sentinel로 관리되는 provider block만 제거합니다. `--set-default`를 사용했고 현재 top-level 값이 설치된 값과 그대로 일치하면 이전 `model`과 `model_provider`를 복구합니다. Sentinel block이 install 이후 바뀌었다면 자동 편집을 거부하고 backup path를 보고합니다.

수동 rollback:

```bash
cp <backup-path> <CODEX_HOME>/config.toml
```
