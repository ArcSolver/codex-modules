<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/custom-models

공식 Codex 앱/CLI 모델 선택기에 Responses API 호환 모델 slug를 등록합니다.

이 패키지는 `CODEX_HOME` 아래에 Codex native 파일을 씁니다: `config.toml`의 provider 블록, 루트 레벨 `model_catalog_json`, 그리고 native Codex 모델 항목을 복제해 만든 catalog JSON입니다. proxy, server, account pool, OAuth flow, model discovery service는 실행하지 않습니다.

## 설치

```bash
npm install -g @codex-modules/custom-models
```

이 repository에서 로컬 개발을 하려면:

```bash
cd modules/custom-models
npm install
npm run build
```

## 빠른 시작

provider를 등록하고 기본 Codex provider로 설정합니다:

```bash
codex-custom-models add \
  --provider openrouter \
  --name "OpenRouter" \
  --base-url https://openrouter.example/v1 \
  --model anthropic/claude-sonnet-4.6 \
  --model google/gemini-3-pro \
  --set-default
```

`config.toml`에 이미 루트 `model_provider`가 있거나 소유되지 않은 `model_catalog_json`이 있으면 명령이 중단됩니다. 이 모듈이 Codex catalog 루트 키를 넘겨받거나 기존 기본 provider가 있는 상태로 진행하길 의도한 경우에만 `--force`로 다시 실행하세요:

```bash
codex-custom-models add \
  --provider openrouter \
  --base-url https://openrouter.example/v1 \
  --model anthropic/claude-sonnet-4.6 \
  --set-default \
  --force
```

실제 Codex home 대신 sandbox를 사용합니다:

```bash
codex-custom-models add \
  --codex-home /tmp/codex-home \
  --provider local \
  --base-url http://127.0.0.1:8000/v1 \
  --model qwen3-coder
```

등록된 모델을 나열합니다:

```bash
codex-custom-models list
codex-custom-models list --json
```

이 모듈이 추적하는 모델을 제거합니다:

```bash
codex-custom-models remove --provider openrouter --model anthropic/claude-sonnet-4.6
codex-custom-models remove --provider openrouter --all
```

가장 최근 journaled transaction을 롤백합니다:

```bash
codex-custom-models rollback
```

설치를 점검합니다:

```bash
codex-custom-models doctor
codex-custom-models doctor --json
```

## API

```ts
import {
  doctor,
  listModels,
  planRegister,
  registerModels,
  removeModels,
  rollback,
} from "@codex-modules/custom-models";

await registerModels({
  codexHome: "/tmp/codex-home",
  providerId: "openrouter",
  providerName: "OpenRouter",
  baseUrl: "https://openrouter.example/v1",
  setDefaultProvider: true,
  models: [
    {
      slug: "anthropic/claude-sonnet-4.6",
      displayName: "Claude Sonnet 4.6",
      contextWindow: 200000,
      inputModalities: ["text"],
      reasoningEfforts: ["low", "medium", "high"],
    },
  ],
});
```

패키지는 다음을 export합니다:

- `planRegister(options)`
- `registerModels(options)`
- `listModels(options?)`
- `removeModels(options)`
- `rollback(options?)`
- `doctor(options?)`

## 작동 방식

`codex-custom-models`는 active catalog, `models_cache.json`, 또는 `codex debug models --bundled`에서 native Codex catalog shape를 읽습니다. 각 custom model마다 하나의 native 항목을 복제하고, slug를 `<provider>/<model>`로 변경하고, 표시 metadata를 업데이트하며, `service_tier`, `service_tiers`, `default_service_tier`, `additional_speed_tiers` 같은 native 전용 fast-tier field를 제거합니다.

`model_catalog_json`과 요청된 경우 `model_provider`는 첫 table header보다 앞선 TOML document root에 작성됩니다. provider table은 표시된 소유 블록으로 append됩니다:

```toml
model_provider = "openrouter"
model_catalog_json = "/Users/me/.codex/codex-custom-models-catalog.json"

# Auto-injected by codex-custom-models
[model_providers."openrouter"]
name = "OpenRouter"
base_url = "https://openrouter.example/v1"
wire_api = "responses"
requires_openai_auth = true
```

등록 후에는 Codex가 catalog를 빠르게 refresh하도록 `models_cache.json`을 expired wrapper로 다시 씁니다.

## 안전과 롤백

- 기존 루트 `model_provider` 충돌은 `--force` 없이는 중단됩니다.
- 기존의 소유되지 않은 루트 `model_catalog_json` 충돌은 `--force` 없이는 중단됩니다.
- 같은 provider id에 대한 기존의 소유되지 않은 provider table은 `--force` 없이는 중단됩니다.
- `remove`는 `codex-custom-models-state/state.json`에서 추적되는 slug만 삭제합니다.
- 모든 일반 쓰기는 `CODEX_HOME/codex-custom-models-state/` 아래에 transaction journal과 backup 파일을 만듭니다.
- `rollback`은 현재 hash가 여전히 transaction과 일치하는 journaled 파일만 복원합니다. transaction 이후 파일이 변경된 경우 rollback은 해당 파일을 건너뛰고 보고합니다.

사용 가능한 native catalog template이 없어 등록에 실패하면, `CODEX_HOME/models_cache.json`이 생기도록 Codex를 한 번 실행하거나 다음을 지원하는 Codex CLI를 설치하세요:

```bash
codex debug models --bundled
```

## 제거

등록한 각 provider의 모든 모델을 제거합니다:

```bash
codex-custom-models list
codex-custom-models remove --provider openrouter --all
```

가장 최근 쓰기를 정확히 되돌리고 싶다면:

```bash
codex-custom-models rollback
```

그다음 패키지를 제거합니다:

```bash
npm uninstall -g @codex-modules/custom-models
```

## 검증

검증 스크립트는 임시 `CODEX_HOME` sandbox를 사용하며 실제 `~/.codex`는 절대 건드리지 않습니다:

```bash
npm run verify
```

## Attribution

Codex home resolver, 루트 TOML 편집, catalog 복제, cache invalidation, journal rollback 로직의 일부는 MIT License로 라이선스된 [opencodex](https://github.com/lidge-jun/opencodex)에서 adapted했습니다.
