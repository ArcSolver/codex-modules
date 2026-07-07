# codex-modules website

The documentation site for [codex-modules](https://github.com/ArcSolver/codex-modules),
built with [Astro Starlight](https://starlight.astro.build/) and deployed to
Cloudflare Pages.

## How it works

**The repo's README files are the single source of truth.** This site does not
keep a second copy of the docs. At build time, `scripts/sync-docs.mjs` reads:

- `README.md` / `README.ko.md` (repo root) → the homepage (`/` and `/ko/`)
- `modules/<name>/README.md` / `README.ko.md` → one page each under `/modules/`

For each file it strips the language-switcher line, lifts the leading `# H1`
into Starlight's `title` frontmatter, derives a `description`, and injects a
stable sidebar order. The generated files land in `src/content/docs/`, which is
git-ignored — **never edit them by hand; edit the source READMEs instead.**

Internationalization (English default at `/`, Korean at `/ko/`), full-text
search (Pagefind), dark mode, and the language switcher are all provided by
Starlight out of the box.

## Local development

```bash
cd website
npm install
npm run dev      # runs sync:docs, then serves at http://localhost:4321
```

`npm run build` regenerates content, builds the static site into `dist/`,
builds the Pagefind search index, and validates all internal links.

## Deployment (Cloudflare Pages)

Connect the repo once in the Cloudflare dashboard
(**Workers & Pages → Create → Pages → Connect to Git**) with:

| Setting | Value |
| --- | --- |
| Project name | `codex-modules` |
| Root directory | `website` |
| Framework preset | `Astro` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Production branch | `main` |
| Custom domain | `codex.arcyou.ai` |

No adapter and no environment variables are required — this is a fully static
build. Every push to `main` rebuilds and deploys automatically, and pull
requests get preview deployments.

The Astro `site` value is `https://codex.arcyou.ai`, so attach that custom
domain before treating sitemap and canonical URLs as production-ready.
