// Generate Starlight content from the repo's canonical README files.
//
// The READMEs are the single source of truth. This script mechanically maps:
//   README.md              -> src/content/docs/index.md            (/)
//   README.ko.md           -> src/content/docs/ko/index.md         (/ko/)
//   modules/<n>/README.md    -> src/content/docs/modules/<n>.md       (/modules/<n>)
//   modules/<n>/README.ko.md -> src/content/docs/ko/modules/<n>.md    (/ko/modules/<n>)
//
// For each file it strips the language-switcher line, lifts the leading H1
// into the Starlight `title` frontmatter, derives a `description`, and (for
// module pages) injects a stable `sidebar.order`. Output lives under
// src/content/docs/, which is git-ignored — never hand-edit generated files.

import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const OUT = path.resolve(HERE, "..", "src", "content", "docs");

// Reading order mirrors the root README module table.
const MODULE_ORDER = [
  "custom-models",
  "config-kit",
  "hooks",
  "skills",
  "mcp-manager",
  "subagents",
  "session-recall",
  "lsp-sidecar",
  "scheduler",
];

// Strip the `<p align="right">…</p>` language switcher we add to every README;
// Starlight renders its own language picker.
function stripSwitcher(md) {
  return md.replace(/^<p align="right">[\s\S]*?<\/p>\s*/i, "");
}

// Pull the first `# H1` as the title and remove it from the body so Starlight
// does not render a duplicate heading.
function liftTitle(md) {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s+(.+?)\s*$/);
    if (m) {
      lines.splice(i, 1);
      // drop a single blank line left behind
      if (lines[i] !== undefined && lines[i].trim() === "") lines.splice(i, 1);
      return { title: m[1].trim(), body: lines.join("\n") };
    }
    if (lines[i].trim() !== "") break; // content before any H1 -> no lift
  }
  return { title: null, body: md };
}

// First non-empty, non-heading, non-html paragraph, flattened to a short
// plain-text description for SEO/social cards.
function deriveDescription(body) {
  const blocks = body.split(/\n\s*\n/);
  for (const block of blocks) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("<") || t.startsWith("```") || t.startsWith("|")) continue;
    const plain = t
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length < 10) continue;
    return plain.length > 160 ? plain.slice(0, 157).trimEnd() + "…" : plain;
  }
  return null;
}

function yamlEscape(s) {
  return `"${s.replace(/"/g, '\\"')}"`;
}

function frontmatter({ title, description, order }) {
  const fm = [`title: ${yamlEscape(title)}`];
  if (description) fm.push(`description: ${yamlEscape(description)}`);
  if (order !== undefined) fm.push(`sidebar:\n  order: ${order}`);
  return `---\n${fm.join("\n")}\n---\n\n`;
}

async function convert(srcRel, outRel, { title: forcedTitle, order } = {}) {
  const srcAbs = path.join(REPO, srcRel);
  if (!existsSync(srcAbs)) return false;
  const raw = await readFile(srcAbs, "utf8");
  const stripped = stripSwitcher(raw);
  const { title: liftedTitle, body } = liftTitle(stripped);
  const title = forcedTitle ?? liftedTitle ?? "Untitled";
  const description = deriveDescription(body);
  const outAbs = path.join(OUT, outRel);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, frontmatter({ title, description, order }) + body.trimStart() + "\n");
  return true;
}

async function main() {
  // Clean previous generation so removed modules do not linger.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Root README -> homepage (English at /, Korean at /ko/).
  const rootJobs = [
    convert("README.md", "index.md"),
    convert("README.ko.md", "ko/index.md"),
  ];

  // Module READMEs. Title is forced to the short module name for clean
  // sidebar/nav labels; order follows MODULE_ORDER.
  const moduleJobs = [];
  MODULE_ORDER.forEach((name, i) => {
    const order = i + 1;
    moduleJobs.push(convert(`modules/${name}/README.md`, `modules/${name}.md`, { title: name, order }));
    moduleJobs.push(convert(`modules/${name}/README.ko.md`, `ko/modules/${name}.md`, { title: name, order }));
  });

  const results = await Promise.all([...rootJobs, ...moduleJobs]);
  const generated = results.filter(Boolean).length;

  console.log(`sync-docs: generated ${generated} pages into src/content/docs/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
