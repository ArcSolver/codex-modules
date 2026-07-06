<p align="right"><a href="README.md">English</a> | 한국어</p>

# @codex-modules/skills

Codex 앱이나 CLI를 수정하지 않고 로컬 Codex skill을 설치, 나열, 제거, 변환, probe, 진단합니다.

## 설치

```bash
npm install -g @codex-modules/skills
```

또는 source에서:

```bash
npm install
npm run build
```

이 패키지 directory에서 CLI로 사용하려면:

```bash
node dist/cli.js list
```

패키지로 설치한 경우 binary는 `codex-skills`입니다.

## 사용법

```bash
codex-skills install ./my-skill --target user
codex-skills install ./my-skill --target repo --repo-root /path/to/repo
codex-skills list
codex-skills remove my-skill --target user
codex-skills rollback --target user
codex-skills convert ./claude-skill
codex-skills doctor --json
```

Programmatic API:

```ts
import { installSkill, listSkills, resolveTargets, validateSkill } from "@codex-modules/skills";

const targets = resolveTargets({ repoRoot: process.cwd() });
const validation = validateSkill("./my-skill");
if (validation.ok) installSkill("./my-skill", { target: "user" });
console.log(targets, listSkills());
```

## 작동 방식

Codex skill은 YAML frontmatter가 있는 필수 `SKILL.md` 파일을 포함한 directory입니다. 이 모듈은 필수 `name` 및 `description` field를 검증하고, 전체 skill directory를 복사하며, 관리되는 설치를 target skill root의 `.codex-skills-manifest.json`에 기록합니다.

지원되는 root:

- `user`: `$HOME/.agents/skills` - 권장되는 user-level 위치입니다.
- `legacy`: `$CODEX_HOME/skills` - backward-compatible 위치입니다.
- `repo`: `<repo>/.agents/skills` - repository-local 위치입니다.

`listSkills()`는 세 root 모두에서 최대 depth 6까지 `SKILL.md`를 recursive scan합니다. `probe()`는 `codex`를 사용할 수 있을 때 `codex debug prompt-input "probe"`를 사용하며, cwd는 repo root로 설정하고 sandbox 가능한 `HOME`/`CODEX_HOME` override를 적용합니다. 이를 통해 OpenAI 인증 없이 offline rendering check를 할 수 있습니다.

`convertClaudeSkill()`은 permissions를 다시 쓰지 않습니다. Claude Code skill에 `allowed-tools`가 포함된 경우, 해당 field가 Codex permissions로 자동 mapping되지 않으므로 codex-skills가 warning을 보고합니다.

## 제거-롤백

`removeSkill()`은 `forceForeign` 또는 CLI `--force-foreign`이 제공되지 않으면 추적되지 않은 skill 제거를 거부합니다. 모든 remove는 skill directory를 삭제하기 전에 `.codex-skills-backups/` 아래에 backup을 만듭니다.

`installSkill(..., { force: true })`도 교체 전에 기존 destination을 backup합니다. `rollback()`은 target root manifest에 기록된 마지막 install 또는 remove를 복원합니다.

```bash
codex-skills remove my-skill --target user
codex-skills rollback --target user
```

rollback을 진행할 수 없다면 다음을 확인하세요:

- `<targetRoot>/.codex-skills-manifest.json`
- `<targetRoot>/.codex-skills-backups/`

## Attribution

검증 및 설치 flow는 bundled `skill-installer` workflow(Apache-2.0)를 포함해 `openai/codex`에 문서화되고 구현된 Codex skills 동작과 호환됩니다.

backup-before-replace 안전 pattern은 `sanztheo/claude-codex-skills-sync`(MIT)에서 사용한 접근 방식을 따릅니다.

`src/kit/`의 일부 로컬 filesystem 및 Codex CLI utility code는 `modules/config-kit/src/`에서 adapted했습니다. 복사된 파일에는 `Adapted from` comments가 포함되어 있습니다.
