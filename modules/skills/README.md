# codex-skills

Install, list, remove, convert, probe, and diagnose local Codex skills without modifying the Codex app or CLI.

## Install

```bash
npm install
npm run build
```

For CLI use from this package directory:

```bash
node dist/cli.js list
```

If installed as a package, the binary is `codex-skills`.

## Usage

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
import { installSkill, listSkills, resolveTargets, validateSkill } from "codex-skills";

const targets = resolveTargets({ repoRoot: process.cwd() });
const validation = validateSkill("./my-skill");
if (validation.ok) installSkill("./my-skill", { target: "user" });
console.log(targets, listSkills());
```

## How It Works

Codex skills are directories containing a required `SKILL.md` file with YAML frontmatter. This module validates the required `name` and `description` fields, copies the full skill directory, and records managed installs in `.codex-skills-manifest.json` at the target skill root.

Supported roots:

- `user`: `$HOME/.agents/skills` - recommended user-level location.
- `legacy`: `$CODEX_HOME/skills` - backward-compatible location.
- `repo`: `<repo>/.agents/skills` - repository-local location.

`listSkills()` scans all three roots for `SKILL.md` recursively up to depth 6. `probe()` uses `codex debug prompt-input "probe"` when `codex` is available, with cwd set to the repo root and sandboxable `HOME`/`CODEX_HOME` overrides. This allows offline rendering checks without OpenAI authentication.

`convertClaudeSkill()` does not rewrite permissions. If a Claude Code skill contains `allowed-tools`, codex-skills reports a warning because that field is not automatically mapped to Codex permissions.

## Uninstall-Rollback

`removeSkill()` refuses to remove untracked skills unless `forceForeign` or CLI `--force-foreign` is provided. Every remove creates a backup under `.codex-skills-backups/` before deleting the skill directory.

`installSkill(..., { force: true })` also backs up the existing destination before replacement. `rollback()` restores the last install or remove recorded in the target root manifest.

```bash
codex-skills remove my-skill --target user
codex-skills rollback --target user
```

If a rollback cannot proceed, inspect:

- `<targetRoot>/.codex-skills-manifest.json`
- `<targetRoot>/.codex-skills-backups/`

## Attribution

The validation and installation flow is compatible with Codex skills behavior documented and implemented in `openai/codex`, including the bundled `skill-installer` workflow (Apache-2.0).

The backup-before-replace safety pattern follows the approach used by `sanztheo/claude-codex-skills-sync` (MIT).

Some local filesystem and Codex CLI utility code in `src/kit/` is adapted from `modules/config-kit/src/`; copied files include `Adapted from` comments.
