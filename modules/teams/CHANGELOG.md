# Changelog

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
