# Publishing

All packages publish under the `@codex-modules` npm scope. Public access is
set per package via `publishConfig.access`, and `prepublishOnly` rebuilds
`dist/` so a stale build can never ship.

## One-time setup

1. `npm login` (enable 2FA).
2. Create the `codex-modules` org on npmjs.com (free for public packages).
   The scope must match the org name.

## Release routine (per release)

```bash
# 1. Full gate: every module against every pinned codex version
scripts/verify-all.sh -v "min latest"

# 2. Inspect what would ship (per module)
cd modules/<name> && npm pack --dry-run

# 3. Publish (config-kit first by convention; there are no runtime
#    cross-dependencies, so order is not load-bearing)
for m in config-kit hooks skills mcp-manager subagents custom-models; do
  (cd modules/$m && npm publish)
done
```

## Rules

- Never publish with a failing verify matrix.
- Bump versions manually per module (they are versioned independently).
- Tarball contents are limited by `files` to `dist/`, `README.md`,
  `LICENSE`, `package.json` — source and verify scripts do not ship.
- The `codex-config-kit` core ships vendored inside each module's
  `dist/kit/`; modules never depend on each other at runtime.
