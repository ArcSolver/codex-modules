# codex-subagents

`codex-subagents` runs multiple `codex exec` workers in parallel and stores every worker result as files. It also reports whether the local Codex binary exposes native `multi_agent` support.

It does not install hooks, edit Codex config, or modify `$CODEX_HOME`.

## Install

```bash
npm install
npm run build
```

Use the CLI from this package:

```bash
node dist/cli.js doctor
```

When installed globally or through npm linking, the command is:

```bash
codex-subagents doctor
```

## Usage

Create `tasks.jsonl`, one `TaskSpec` per line:

```jsonl
{"id":"map","prompt":"Inspect the source tree and summarize likely entry points.","cwd":"/path/to/repo","sandbox":"read-only","model":"gpt-5.5","effort":"high"}
{"id":"tests","prompt":"Inspect test coverage gaps. Do not edit files.","cwd":"/path/to/repo","sandbox":"read-only","configOverrides":{"agents.max_depth":"1"}}
```

Run with a concurrency cap:

```bash
codex-subagents run --tasks tasks.jsonl --out .work/subagents/run-001 --parallel 2 --timeout 600 --stall 180
```

Outputs:

- `<out>/<id>.md`: final message from `codex exec -o`
- `<out>/<id>.events.jsonl`: `--json` event stream from stdout
- `<out>/<id>.stderr.log`: stderr from the worker process

Programmatic API:

```ts
import { runTasks, detectNative } from "codex-subagents";

const native = detectNative();
const results = await runTasks(
  [{ id: "one", prompt: "Summarize this repo.", sandbox: "read-only" }],
  { outDir: ".work/subagents/example", parallel: 2 },
);
```

## How It Works

The default engine is an external `codex exec` runner. Each task is spawned as:

```text
codex exec --skip-git-repo-check [-C cwd] -s <sandbox> [-m model] [-c model_reasoning_effort=...] [-c k=v ...] [--output-schema file] -o <out>/<id>.md --json --ephemeral <prompt>
```

The runner passes the prompt as an argv argument and sets worker stdin to `/dev/null`. This avoids the known hang case where piped stdin can wait for EOF in automation.

Concurrency is controlled by an in-process semaphore. `parallel = 2` means at most two child `codex exec` processes are open at once.

Stall detection watches the mtimes of the final message, JSONL event stream, and stderr log. If none of them changes for `stallSec`, the child is killed and the task status is `stall`. If wall-clock runtime exceeds `timeoutSec`, the status is `timeout`.

With `--resume`, an existing `<out>/<id>.md` is treated as complete and that task is skipped. This makes interrupted runs idempotent at the artifact level.

Native `multi_agent` is diagnostic only in this module. Local Codex versions can report `multi_agent` as stable and enabled, but related fan-out surfaces such as `enable_fanout`, `multi_agent_v2`, and `child_agents_md` may be under development. For predictable pipeline operation, this package keeps the exec runner as the default and reports native feature state through `doctor`.

Dangerous sandbox bypass options are intentionally not exposed. Task sandboxes are limited to `read-only` and `workspace-write`, and config overrides containing bypass or danger-full-access values are rejected.

## Attribution

Runner design references `kimsh-1/codex-fleet` (MIT): https://github.com/kimsh-1/codex-fleet

Orchestration structure references `leonardsellem/codex-specialized-subagents` (MIT): https://github.com/leonardsellem/codex-specialized-subagents

This module vendors local kit utilities adapted from `modules/config-kit/src/` in this repository. Vendored source files carry `// Adapted from modules/config-kit/src/<file>.ts` comments.

## Uninstall Rollback

This package does not edit Codex settings, register MCP servers, or write to the real `$CODEX_HOME`. Rollback is stopping any running `codex-subagents` process and deleting the output directory you passed with `--out`.

If installed globally, remove it with your package manager:

```bash
npm uninstall -g codex-subagents
```
