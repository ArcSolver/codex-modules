<p align="right">English | <a href="README.ko.md">한국어</a></p>

# @codex-modules/custom-models

Register Responses-API-compatible model slugs in the official Codex app/CLI model picker.

This package writes Codex-native files under `CODEX_HOME`: a provider block in `config.toml`, a root-level `model_catalog_json`, and a catalog JSON built by cloning a native Codex model entry. It does not run a proxy, server, account pool, OAuth flow, or model discovery service.

## Install

```bash
npm install -g @codex-modules/custom-models
```

For local development from this repository:

```bash
cd modules/custom-models
npm install
npm run build
```

## Quickstart

Register a provider and make it the default Codex provider:

```bash
codex-custom-models add \
  --provider openrouter \
  --name "OpenRouter" \
  --base-url https://openrouter.example/v1 \
  --model anthropic/claude-sonnet-4.6 \
  --model google/gemini-3-pro \
  --set-default
```

If `config.toml` already has a root `model_provider` or a non-owned `model_catalog_json`, the command aborts. Re-run with `--force` only when you intentionally want this module to take over the Codex catalog root key or proceed with an existing default provider:

```bash
codex-custom-models add \
  --provider openrouter \
  --base-url https://openrouter.example/v1 \
  --model anthropic/claude-sonnet-4.6 \
  --set-default \
  --force
```

Use a sandbox instead of your real Codex home:

```bash
codex-custom-models add \
  --codex-home /tmp/codex-home \
  --provider local \
  --base-url http://127.0.0.1:8000/v1 \
  --model qwen3-coder
```

List registered models:

```bash
codex-custom-models list
codex-custom-models list --json
```

Remove models tracked by this module:

```bash
codex-custom-models remove --provider openrouter --model anthropic/claude-sonnet-4.6
codex-custom-models remove --provider openrouter --all
```

Rollback the latest journaled transaction:

```bash
codex-custom-models rollback
```

Check the install:

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

The package exports:

- `planRegister(options)`
- `registerModels(options)`
- `listModels(options?)`
- `removeModels(options)`
- `rollback(options?)`
- `doctor(options?)`

## How It Works

`codex-custom-models` reads the native Codex catalog shape from the active catalog, `models_cache.json`, or `codex debug models --bundled`. It clones one native entry for each custom model, changes the slug to `<provider>/<model>`, updates the display metadata, and removes native-only fast-tier fields such as `service_tier`, `service_tiers`, `default_service_tier`, and `additional_speed_tiers`.

`model_catalog_json` and, when requested, `model_provider` are written at the TOML document root before the first table header. The provider table is appended as a marked owned block:

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

After registration, `models_cache.json` is rewritten as an expired wrapper so Codex refreshes the catalog promptly.

## Safety And Rollback

- Existing root `model_provider` conflicts abort unless `--force`.
- Existing non-owned root `model_catalog_json` conflicts abort unless `--force`.
- Existing non-owned provider tables for the same provider id abort unless `--force`.
- `remove` deletes only slugs tracked in `codex-custom-models-state/state.json`.
- Every normal write creates a transaction journal and backup files under `CODEX_HOME/codex-custom-models-state/`.
- `rollback` restores journaled files only when their current hashes still match the transaction. If a file changed after the transaction, rollback skips that file and reports it.

If registration fails because no native catalog template is available, run Codex once so `CODEX_HOME/models_cache.json` exists, or install a Codex CLI that supports:

```bash
codex debug models --bundled
```

## Uninstall

Remove all models for each provider you registered:

```bash
codex-custom-models list
codex-custom-models remove --provider openrouter --all
```

If you want to undo the latest write exactly:

```bash
codex-custom-models rollback
```

Then remove the package:

```bash
npm uninstall -g @codex-modules/custom-models
```

## Verification

The verification script uses temporary `CODEX_HOME` sandboxes and never touches your real `~/.codex`:

```bash
npm run verify
```

## Attribution

Parts of the Codex home resolver, root TOML editing, catalog cloning, cache invalidation, and journal rollback logic are adapted from [opencodex](https://github.com/lidge-jun/opencodex), licensed under the MIT License.

