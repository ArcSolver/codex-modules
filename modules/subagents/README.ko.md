<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/subagents

`codex-subagents`는 여러 `codex exec` worker를 병렬로 실행하고 모든 worker result를 파일로 저장합니다. 또한 local Codex binary가 native `multi_agent` support를 노출하는지 보고합니다.

hook을 설치하거나, Codex config를 편집하거나, `$CODEX_HOME`을 수정하지 않습니다.

## 설치

```bash
npm install -g @codex-modules/subagents
```

또는 source에서:

```bash
npm install
npm run build
```

이 package의 CLI를 사용하세요:

```bash
node dist/cli.js doctor
```

global로 설치했거나 npm linking을 통해 설치했다면 command는 다음과 같습니다:

```bash
codex-subagents doctor
```

## 사용법

line마다 하나의 `TaskSpec`을 담아 `tasks.jsonl`을 만드세요:

```jsonl
{"id":"map","prompt":"Inspect the source tree and summarize likely entry points.","cwd":"/path/to/repo","sandbox":"read-only","model":"gpt-5.5","effort":"high"}
{"id":"tests","prompt":"Inspect test coverage gaps. Do not edit files.","cwd":"/path/to/repo","sandbox":"read-only","configOverrides":{"agents.max_depth":"1"}}
```

concurrency cap과 함께 실행:

```bash
codex-subagents run --tasks tasks.jsonl --out .work/subagents/run-001 --parallel 2 --timeout 600 --stall 180
```

Outputs:

- `<out>/<id>.md`: `codex exec -o`의 final message
- `<out>/<id>.events.jsonl`: stdout의 `--json` event stream
- `<out>/<id>.stderr.log`: worker process의 stderr

Programmatic API:

```ts
import { runTasks, detectNative } from "@codex-modules/subagents";

const native = detectNative();
const results = await runTasks(
  [{ id: "one", prompt: "Summarize this repo.", sandbox: "read-only" }],
  { outDir: ".work/subagents/example", parallel: 2 },
);
```

## 작동 방식

기본 engine은 external `codex exec` runner입니다. 각 task는 다음처럼 spawn됩니다:

```text
codex exec --skip-git-repo-check [-C cwd] -s <sandbox> [-m model] [-c model_reasoning_effort=...] [-c k=v ...] [--output-schema file] -o <out>/<id>.md --json --ephemeral <prompt>
```

runner는 prompt를 argv argument로 전달하고 worker stdin을 `/dev/null`로 설정합니다. 이렇게 하면 piped stdin이 automation에서 EOF를 기다릴 수 있는 알려진 hang case를 피합니다.

Concurrency는 in-process semaphore로 제어됩니다. `parallel = 2`는 한 번에 최대 두 개의 child `codex exec` process만 열려 있음을 의미합니다.

Stall detection은 final message, JSONL event stream, stderr log의 mtime을 감시합니다. 그중 아무것도 `stallSec` 동안 변경되지 않으면 child가 kill되고 task status는 `stall`이 됩니다. wall-clock runtime이 `timeoutSec`를 초과하면 status는 `timeout`입니다.

`--resume`을 사용하면 기존 `<out>/<id>.md`를 complete로 간주하고 해당 task를 skip합니다. 이로써 interrupted run은 artifact level에서 idempotent해집니다.

Native `multi_agent`는 이 module에서 diagnostic 전용입니다. Local Codex version은 `multi_agent`를 stable and enabled로 보고할 수 있지만, `enable_fanout`, `multi_agent_v2`, `child_agents_md` 같은 관련 fan-out surface는 under development일 수 있습니다. 예측 가능한 pipeline operation을 위해 이 package는 exec runner를 default로 유지하고 `doctor`를 통해 native feature state를 보고합니다.

Dangerous sandbox bypass option은 의도적으로 노출하지 않습니다. Task sandbox는 `read-only`와 `workspace-write`로 제한되며, bypass 또는 danger-full-access value를 포함한 config override는 reject됩니다.

## Attribution

Runner design은 `kimsh-1/codex-fleet` (MIT)를 reference합니다: https://github.com/kimsh-1/codex-fleet

Orchestration structure는 `leonardsellem/codex-specialized-subagents` (MIT)를 reference합니다: https://github.com/leonardsellem/codex-specialized-subagents

이 module은 이 repository의 `modules/config-kit/src/`에서 adapted된 local kit utility를 vendor합니다. Vendored source file에는 `// Adapted from modules/config-kit/src/<file>.ts` comment가 있습니다.

## 제거 롤백

이 package는 Codex setting을 편집하거나, MCP server를 register하거나, 실제 `$CODEX_HOME`에 쓰지 않습니다. 롤백은 실행 중인 `codex-subagents` process를 중지하고 `--out`으로 전달한 output directory를 삭제하는 것입니다.

global로 설치했다면 package manager로 제거하세요:

```bash
npm uninstall -g @codex-modules/subagents
```
