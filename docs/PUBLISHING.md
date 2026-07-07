# Publishing

All packages publish under the `@codex-modules` npm scope. Public access is
set per package via `publishConfig.access`, and `prepublishOnly` rebuilds
`dist/` so a stale build can never ship.

## One-time setup

1. Create the `codex-modules` org on npmjs.com (free for public packages).
   The scope must match the org name.
2. For each package, connect npm trusted publishing:
   - Open the package on npmjs.com.
   - Go to `Settings` -> `Trusted Publisher`.
   - Add GitHub Actions with repository `ArcSolver/codex-modules` and workflow
     file `release.yml`.
3. For manual fallback only, `npm login` locally and enable 2FA.

## Release routine (default)

Use the GitHub Actions `Release module` workflow (`.github/workflows/release.yml`)
for normal releases. It publishes with npm trusted publishing, so no
`NODE_AUTH_TOKEN` is required.

1. Bump the target module's `modules/<name>/package.json` version.
2. Open GitHub Actions -> `Release module` -> `Run workflow`.
3. Select one module:
   - `config-kit`
   - `hooks`
   - `skills`
   - `mcp-manager`
   - `subagents`
   - `custom-models`
   - `session-recall`
   - `lsp-sidecar`
   - `scheduler`
   - `teams`
   - `with-claude`
4. Enter the exact version from `modules/<name>/package.json`.
5. Run the workflow.

The workflow installs Node.js 24 and the latest npm CLI, checks that the input
version matches `package.json`, runs:

```bash
bash scripts/verify-all.sh -v "min latest" <module>
```

and then publishes from `modules/<name>`:

```bash
npm publish
```

Trusted publishing requires npm CLI 11.5.1 or newer. The workflow installs
`npm@latest` before publishing, and npm attaches provenance automatically for
trusted GitHub Actions publishes.

## Manual fallback

Use this only if trusted publishing is unavailable or npmjs.com/GitHub setup is
not ready. This path requires local npm authentication and 2FA web approval.
Run `npm publish` from a pseudo-TTY when npm needs browser-based 2FA approval.

```bash
# 1. Full gate: every module against every pinned codex version
scripts/verify-all.sh -v "min latest"

# 2. Inspect what would ship (per module)
cd modules/<name> && npm pack --dry-run

# 3. Publish (config-kit first by convention; there are no runtime
#    cross-dependencies, so order is not load-bearing)
for m in config-kit hooks skills mcp-manager subagents custom-models \
         session-recall lsp-sidecar scheduler teams with-claude; do
  (cd modules/$m && script -q /dev/null npm publish)
done
```

## Rules

- Never publish with a failing verify matrix.
- Bump versions manually per module (they are versioned independently).
- Prefer the `Release module` workflow. Use manual publishing only as a
  fallback.
- Tarball contents are limited by `files` to runtime artifacts, package docs,
  `LICENSE`, and npm's implicit `package.json` — source and verify scripts do
  not ship.
- The `codex-config-kit` core ships vendored inside each module's
  `dist/kit/`; modules never depend on each other at runtime.
