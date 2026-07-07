# Changelog

## 0.2.0

- Added experimental `HarnessProfile` seam (`nativeV1Harness`): leader/member prompt discipline, runner argv, event summary, and doctor health check are now assembled through a single profile object accepted by `assembleLeaderPrompt`, `assembleDeveloperInstructions`, `renderTeamsSkill`, `buildRunPlan`, `runTeam`, and `doctorIsHealthy`. Shape may change until a second transport lands (not covered by semver).
- Added `task complete --meta <json>`: stores structured handoff metadata in `result_meta` (additive; complete path only, invalid JSON rejected).
- Added task-scoped journal notes: `note add --task <id>` (validates the task exists) and `note list --task <id>`.
- Added `task reopen <team> <task-id> --actor <name>`: returns a claimed task to open, clearing the claim and lease; open/done/failed tasks are rejected. Leader prompt and SKILL now reference it for member-failure recovery.
- CLI now rejects unknown flags per command (`unknown flag --x for '<command>'`), including `--x=value` and `--dangerously-*` forms; `-s` is accepted only by `run`.
- Help/README now document `run --codex-home/--state-dir`, `doctor --state-dir`, and `skill install --force`.
- verify: golden-output gate (leader prompt, member instructions, SKILL, runner argv, doctor report) plus JSON edge-case and old-schema state-file regression coverage.
- State files remain version 1; new fields are additive and older files are read unchanged.

## 0.1.1

- Security: confine project-scope uninstall manifest entries to the selected agents root and skip unsafe or scope-mismatched entries with warnings.
- Security: reject project-owned `.codex` and `.codex-teams` roots that resolve through symlink components outside the project.
- Removed fragile `run` goal substring filtering; safety now relies on sandbox allow-listing, no danger-access argv, and a single positional prompt argument.
- Escaped all TOML basic-string control characters, including backspace and DEL.
- Removed stale managed agent files when reinstalling a team with fewer or changed members.
- Parsed `codex debug models` as structured JSON only, using `models[].slug` or `models[].id`.
- Fixed CLI value parsing so negative numeric flag values reach validation and are rejected.
- Split `doctor` installed-team reporting into user and project scopes.
- Removed dead `src/kit` code, cleared runtime dependencies, and narrowed the package root export surface.

## 0.1.0

- Initial `@codex-modules/teams` package.
