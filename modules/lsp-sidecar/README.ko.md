<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/lsp-sidecar

`codex-lsp-sidecar`는 Codex에 네 가지 로컬 language-server tool을 제공하는 stdio MCP server를 실행합니다:

- `lsp_diagnostics`
- `lsp_definition`
- `lsp_hover`
- `lsp_workspace_symbol`

## 설치

```bash
npm install -g @codex-modules/lsp-sidecar
```

또는 source에서:

```bash
npm install
npm run build
```

이 패키지는 runtime npm dependencies가 없습니다. Language server는 target workspace, 이 모듈의 `node_modules/.bin`, 또는 `PATH`에서 발견됩니다.

## 사용법

먼저 workspace를 확인합니다:

```bash
codex-lsp-sidecar doctor --root /path/to/repo
```

MCP server를 실행합니다:

```bash
codex-lsp-sidecar serve --root /path/to/repo
```

Codex에 직접 등록합니다:

```bash
codex mcp add lsp -- codex-lsp-sidecar serve --root /path/to/repo
```

또는 이 repo의 MCP manager 모듈을 통해 등록합니다:

```bash
codex-mcp-manager add \
  --name lsp \
  --command codex-lsp-sidecar \
  --arg serve \
  --arg --root \
  --arg /path/to/repo
```

file-position tool은 editor coordinates와 일치하도록 1-based line 및 character 값을 사용합니다.

## 작동 방식

sidecar는 stdout을 MCP frame용으로 예약하고 log는 stderr에 씁니다. Codex에 필요한 작은 stdio JSON-RPC surface인 `initialize`, `tools/list`, `tools/call`, common notifications를 구현합니다.

LSP server는 처음 관련 tool call이 있을 때 lazily 시작됩니다. sidecar는 language server를 다운로드하거나, package를 설치하거나, Codex configuration을 편집하지 않습니다. 현재 TypeScript, Biome, optional ESLint server를 발견하는 방법을 알고 있습니다:

- TypeScript에는 `typescript-language-server`와 resolve 가능한 `typescript/lib/tsserver.js`가 필요합니다.
- Biome에는 `biome` binary가 필요합니다.
- ESLint에는 resolve 가능한 `eslint` package와 `vscode-eslint-language-server`가 필요합니다.

네 tool은 항상 모두 나열됩니다. 호출에 사용할 수 있는 matching server가 없으면 tool은 `isError: true`와 `code: "LSP_SERVER_UNAVAILABLE"`를 포함한 structured content를 반환합니다.

Idle LSP client는 기본적으로 10분 뒤 종료됩니다. debugging 중 idle shutdown을 비활성화하려면 `--idle-ms 0`을 사용하세요.

## Attribution

LSP 구현의 일부는 SST의 OpenCode 프로젝트(MIT 라이선스)를 가져와 수정한 것입니다: https://github.com/sst/opencode

## 제거-롤백

npm package를 제거합니다:

```bash
npm uninstall -g @codex-modules/lsp-sidecar
```

package를 제거해도 Codex MCP configuration은 편집되지 않습니다. MCP registration은 별도로 제거하세요:

```bash
codex mcp remove lsp
```

또는 이 repo의 MCP manager 모듈을 통해 제거합니다:

```bash
codex-mcp-manager remove lsp
```
