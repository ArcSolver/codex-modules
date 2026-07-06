<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/config-kit

Codex configuration surface를 읽고 편집하기 위한 안전한 utility입니다.

`codex-config-kit`는 작은 Node library와 최소 CLI로 구성됩니다. Codex state를 inspect하고, line-oriented config를 안전하게 edit하며, backup을 만들고, caller가 변경을 roll back할 수 있을 만큼의 정보를 기록해야 하는 다른 `codex-*` module이 vendoring하도록 의도되었습니다.

## 설치

```sh
npm install @codex-modules/config-kit
```

이 module 안에서 local development를 할 때:

```sh
npm install
npm run build
```

## 사용법

CLI:

```sh
codex-config-kit doctor
codex-config-kit doctor --json
codex-config-kit validate-toml ~/.codex/config.toml
codex-config-kit backup ~/.codex/config.toml
```

Library:

```ts
import {
  backupFile,
  insertUnderTomlTable,
  spliceManagedBlock,
  writeFileAtomic,
} from "@codex-modules/config-kit";

const backup = backupFile(configPath);
const next = spliceManagedBlock(current, "codex-example", "settings", "enabled = true");
writeFileAtomic(configPath, next);
```

## 동작 방식

이 package는 Codex config file 전체를 다시 serialize하지 않습니다. Whole-file TOML serialization은 comment와 formatting을 파괴하므로, TOML 지원은 validation과 기존 table header 아래의 targeted insertion으로 제한됩니다.

safe editing primitive는 다음과 같습니다:

- `backupFile`: 기존 file을 기본적으로 `.codex-kit-backups/`에 복사합니다.
- `writeFileAtomic`: 같은 directory에 temp file을 쓰고, 기존 file mode를 보존한 뒤, rename으로 제자리에 놓습니다.
- `renderManagedBlock` 및 `spliceManagedBlock`: 명시적인 `# >>> owner:blockId managed`와 `# <<< owner:blockId` marker 안의 text만 소유합니다.
- `insertUnderTomlTable`: 정확한 `[table]` header를 찾아 다음 table header 바로 앞에 line을 삽입한 뒤, 결과를 `smol-toml`로 parse합니다.
- `appendChange` 및 `readChanges`: higher-level module이 rollback에 사용할 수 있는 JSONL manifest를 유지합니다.

Codex discovery helper는 read-only입니다:

- `resolveCodexHome`은 `CODEX_HOME`을 resolve하거나 `~/.codex`로 fallback합니다.
- `findCodexBinary`, `getCodexVersion`, `listFeatures`는 local Codex CLI가 있을 때 이를 inspect합니다.
- `appServerRequest`는 `codex app-server`를 시작하고, newline-delimited stdio 위에서 JSON-RPC를 initialize하며, request 하나를 보낸 뒤, matching response 이후 child를 종료합니다.

## 제거와 롤백

이 package를 제거하면 helper library만 제거됩니다. 어떤 module이 그것을 사용했는지, 어떤 변경을 되돌려야 하는지는 알지 못합니다.

higher-level module은 모든 file write를 `appendChange`로 기록해야 하며, file path와 `backupFile` 또는 `writeJsonAtomic`이 반환한 backup을 저장해야 합니다. Rollback은 recorded backup을 changed file 위에 atomic write로 복원하거나, prior file이 없었던 경우 owned managed block을 제거해야 합니다.

기본 helper가 만든 backup은 edited file 옆에 있습니다:

```text
<file directory>/.codex-kit-backups/
```

## Attribution

이 module은 이 repository에서 구현되었습니다.
