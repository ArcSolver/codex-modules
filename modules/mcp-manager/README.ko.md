<p align="right"><a href="README.md">English</a> | 한국어</p>

# MCP Manager

충돌 검사, 백업, advanced-key 패치, dry-run 계획, 롤백을 갖춰 Codex MCP 서버 등록을 안전하게 관리합니다.

## 하는 일

`codex-mcp-manager`는 공식 `codex mcp` CLI를 감싸는 작은 wrapper입니다. 일반적인 add, remove, list, get 작업은 Codex에 위임해 공식 writer와 validation이 계속 책임지게 하고, 반복 가능한 setup script에 유용한 안전 기능을 더합니다:

- add 전에 이름 충돌 감지
- `config.toml` 변경 전 백업 생성
- 롤백용 backup manifest 기록
- dry-run 계획 지원
- `codex mcp add`가 노출하지 않는 advanced MCP table key 패치
- plaintext bearer token 거부; 대신 environment-variable reference 사용

manager는 stdio server와 streamable HTTP server를 지원합니다.

## 설치

```sh
npm install @codex-modules/mcp-manager
```

이 repository 안에서 local development를 할 때:

```sh
cd modules/mcp-manager
npm install
npm run build
```

## 사용법

stdio server 추가:

```sh
codex-mcp-manager add \
  --name docs \
  --command node \
  --arg /path/to/server.js
```

streamable HTTP server 추가:

```sh
codex-mcp-manager add \
  --name web \
  --url https://mcp.example.com/mcp \
  --bearer-token-env-var MCP_WEB_TOKEN
```

JSON에서 server definition 읽기:

```json
{
  "name": "github",
  "url": "https://mcp.example.com/github",
  "bearerTokenEnvVar": "GITHUB_MCP_TOKEN",
  "httpHeaders": {
    "X-Client": "codex"
  }
}
```

```sh
codex-mcp-manager plan --from github.json --json
codex-mcp-manager add --from github.json --force
```

기존 `[mcp_servers.<name>]` table 아래의 advanced key 패치:

```sh
codex-mcp-manager patch github \
  --set startup_timeout_sec=20 \
  --set 'enabled_tools=["search","open"]'
```

server 검사 또는 제거:

```sh
codex-mcp-manager list --json
codex-mcp-manager get github --json
codex-mcp-manager remove github
codex-mcp-manager doctor
```

어떤 command에서든 `--codex-home DIR`을 사용하면 현재 사용자 기본값인 `~/.codex` 대신 격리된 Codex home을 대상으로 삼을 수 있습니다.

## API

```ts
import {
  addServer,
  doctor,
  getServer,
  listServers,
  patchServer,
  patchServerText,
  plan,
  removeServer,
  rollback,
  type ServerDef,
} from "@codex-modules/mcp-manager";

const def: ServerDef = {
  name: "web",
  url: "https://mcp.example.com/mcp",
  bearerTokenEnvVar: "MCP_WEB_TOKEN",
};

await plan(def, { codexHome: "/tmp/codex-home" });
await addServer(def, { codexHome: "/tmp/codex-home", force: true });
await patchServer("web", { startup_timeout_sec: 20 }, { codexHome: "/tmp/codex-home" });
await rollback({ codexHome: "/tmp/codex-home" });
```

`ServerDef`는 다음 중 하나를 받습니다:

- stdio: `{ name, command, args?, env?, envVars? }`
- HTTP: `{ name, url, bearerTokenEnvVar?, httpHeaders? }`

plaintext bearer token을 전달하지 마세요. `bearer_token`, `bearer-token`, `bearerToken`이라는 이름의 값은 거부됩니다. secret은 environment variable에 저장하고 `bearerTokenEnvVar`를 전달하세요.

`patchServerText(content, name, keys)`는 disk를 건드리지 않고 table patch를 미리 확인해야 하는 fixture test와 tool을 위해 export됩니다.

## 동작 방식

add, remove, list, get에서는 이 module이 설치된 `codex` binary를 호출하며, `CODEX_HOME`은 요청된 target directory로 설정합니다. mutating operation 전에는 `config.toml`을 다음 위치로 복사합니다:

```text
<CODEX_HOME>/codex-mcp-manager-state/backups/
```

각 backup은 다음 위치에 기록됩니다:

```text
<CODEX_HOME>/codex-mcp-manager-state/manifest.jsonl
```

`patchServer`는 의도적으로 TOML rewriter보다 좁은 범위를 다룹니다. 파일을 validate하고, `[mcp_servers.<name>]` 안에서 요청된 key만 삽입하거나 교체한 뒤, 다시 validate하고 `codex mcp get --json`에 결과 parsing을 맡깁니다. 이렇게 하면 `config.toml`의 관련 없는 부분을 다시 serialize하지 않습니다.

Codex 자체는 `codex mcp add`가 MCP server table을 교체할 때 해당 table을 다시 serialize할 수 있습니다. top-level comment와 관련 없는 key는 유지될 것으로 예상되지만, 영향을 받은 MCP server table 안의 comment는 Codex가 보존하지 않습니다.

## 제거와 롤백

npm package를 제거해도 Codex configuration은 수정되지 않습니다:

```sh
npm uninstall @codex-modules/mcp-manager
```

이 module이 만든 마지막 변경을 되돌리려면:

```sh
codex-mcp-manager rollback
```

격리된 home의 경우:

```sh
codex-mcp-manager rollback --codex-home /tmp/codex-home
```

CLI를 사용할 수 없다면, `<CODEX_HOME>/codex-mcp-manager-state/backups/`의 최신 backup을 `<CODEX_HOME>/config.toml` 위에 복사해 수동으로 복원하세요. `<CODEX_HOME>/codex-mcp-manager-state/manifest.jsonl`의 manifest는 각 backup이 어떤 file에 속하는지 기록합니다.

## Attribution

Schema mapping은 `jtianling/mcps-manager` (MIT)를 참고했습니다. Writer와 backup pattern은 `Brightwing-Systems-LLC/mcp-manager` (MIT)를 참고했습니다.
