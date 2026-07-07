// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLinksValidator from "starlight-links-validator";

const SITE = "https://codex.arcyou.ai";

export default defineConfig({
  site: SITE,
  integrations: [
    starlight({
      title: "codex-modules",
      description:
        "Small, self-contained modules that make the official OpenAI Codex app/CLI truly yours.",
      customCss: ["./src/styles/arcyou-theme.css"],
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
