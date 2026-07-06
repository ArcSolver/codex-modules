// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLinksValidator from "starlight-links-validator";

// Update `site` if a custom domain is attached; the pages.dev URL is derived
// from the Cloudflare Pages project name.
const SITE = "https://codex-modules.pages.dev";

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: "codex-modules",
      description:
        "Small, self-contained modules that make the official OpenAI Codex app/CLI truly yours.",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/ArcSolver/codex-modules" },
      ],
      // No editLink: pages are generated from the canonical READMEs, so an
      // "Edit this page" link would point at git-ignored generated files.
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ko: { label: "한국어", lang: "ko" },
      },
      sidebar: [
        { label: "Overview", translations: { ko: "개요" }, link: "/" },
        {
          label: "Modules",
          translations: { ko: "모듈" },
          items: [{ autogenerate: { directory: "modules" } }],
        },
      ],
      plugins: [starlightLinksValidator()],
    }),
    sitemap(),
  ],
});
