<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/hooks

`codex-hooks`는 Codex lifecycle hooks를 설치, 제거, 신뢰, 진단, 래핑합니다.

두 가지 backend를 지원합니다:

- installed: command hook을 `$CODEX_HOME/hooks.json`에 merge하고, 외부 hook을 보존하며, 신뢰된 hook hash를 `$CODEX_HOME/config.toml`에 씁니다.
- session-flags: 단일 호출용 `-c hooks.SessionStart=[...]` 같은 `codex exec` argv fragment를 만듭니다.

## 설치

```bash
npm install -g @codex-modules/hooks
```

또는 source에서:

```bash
npm install
npm run build
```

sandboxed install에는 `--codex-home DIR` 또는 `CODEX_HOME=DIR`를 사용하세요. 이 library는 runtime에 다른 module을 필요로 하지 않습니다.

## 사용법

`hookset.json`을 만드세요:

```json
{
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        {
          "type": "command",
          "command": "/path/to/hook.sh",
          "timeout": 5,
          "statusMessage": "Starting hook"
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "/path/to/hook.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

Installed backend:

```bash
codex-hooks plan --hooks hookset.json --codex-home /tmp/codex-home
codex-hooks apply --hooks hookset.json --codex-home /tmp/codex-home
codex-hooks trust --codex-home /tmp/codex-home
codex-hooks status --codex-home /tmp/codex-home
```

Wrapper backend:

```bash
codex-hooks exec-args --hooks hookset.json
# Copy the printed argv after `codex exec`, then add your prompt.
```

script에서는 JSON을 선호하고, 반환된 array를 직접 전달하세요:

```bash
codex-hooks exec-args --hooks hookset.json --json
```

기본적으로 `exec-args`는 `--dangerously-bypass-hook-trust`를 포함합니다. session flag에는 persisted trust state가 없기 때문입니다. 생략하려면 `--no-bypass-trust`를 사용하세요.

## 작동 방식

Installed backend는 `$CODEX_HOME/hooks.json`을 읽고, PascalCase Codex hook event를 검증한 뒤, 누락된 command hook만 추가합니다. 외부 hook은 보존됩니다. 같은 event, matcher, command에 대해 `apply`를 다시 실행해도 idempotent합니다.

Installed entry는 `$CODEX_HOME/.codex-hooks-manifest.json`에 추적됩니다. `remove`는 그 manifest를 사용해 `codex-hooks`가 소유한 entry만 삭제한 뒤, `config.toml`에서 관리되는 trust block을 제거합니다.

`trust`는 `{ cwds }`와 함께 Codex app-server method `hooks/list`를 호출하고, 설치된 각 hook의 `key`와 `currentHash`를 읽은 뒤 다음을 씁니다:

```toml
[hooks.state."<key>"]
trusted_hash = "sha256:..."
enabled = true
```

이 TOML entry들은 `codex-hooks`가 소유한 managed block에 포함되며, 쓰기 전에 검증됩니다.

Version matrix:

| Codex version | installed backend | session-flags backend |
| --- | --- | --- |
| 0.139.x | hooks/list discovery와 hooks.state trust 검증됨; exec firing은 관찰되지 않음 | warn: exec-path firing unverified/broken (measured: 0.139 no-fire) |
| 0.142+ | installed hook discovery 예상됨 | ok: session flag firing measured on 0.142.5 |

`doctor`는 Codex binary, version, `hooks` feature state, `hooks/list` availability, discovered hooks, session-flags version gate를 보고합니다.

## 제거-롤백

`hooks.json`과 `config.toml`의 모든 변경은 쓰기 전에 백업됩니다. 백업은 대상 파일 옆 `.codex-kit-backups/` 아래에 저장됩니다. 예:

```text
$CODEX_HOME/.codex-kit-backups/hooks.json.2026-07-05T00-00-00-000Z.12345.bak
```

managed entry 제거:

```bash
codex-hooks remove --codex-home "$CODEX_HOME"
```

`codex-hooks`가 원래 `hooks.json`을 만들었고 남은 hook이 없다면, 제거 중 파일을 삭제합니다:

```bash
codex-hooks remove --codex-home "$CODEX_HOME" --delete-created-file
```

백업에서 수동 롤백:

```bash
cp "$CODEX_HOME/.codex-kit-backups/hooks.json.<stamp>.bak" "$CODEX_HOME/hooks.json"
cp "$CODEX_HOME/.codex-kit-backups/config.toml.<stamp>.bak" "$CODEX_HOME/config.toml"
```

## Attribution

merge와 ownership pattern은 MIT-licensed `plastic-labs/codex-honcho` project를 기반으로 합니다: https://github.com/plastic-labs/codex-honcho

trust automation pattern은 MIT-licensed `aannoo/hcom` project를 기반으로 합니다: https://github.com/aannoo/hcom

`src/kit/`의 local configuration helper code는 이 repository의 `modules/config-kit` package에서 adapted되었습니다.
