import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ManifestEntry } from "./types.js";
import { backupSkillFile, resolveCodexHome, readManifest, writeManifest } from "./agents.js";
import type { HarnessProfile } from "./harness.js";
import { nativeV1Harness } from "./harness.js";
import { nowIso, writeFileAtomic } from "./state.js";

export type SkillInstallOptions = {
  codexHome?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export function renderTeamsSkill(profile: HarnessProfile = nativeV1Harness): string {
  return `---
name: teams
description: Use when a task should be handled by a declared Codex team with native stable multi-agent collaboration, durable task leases, and a leader-owned journal.
---

# Codex Teams

Use this skill when the user asks for a team, panel, swarm, or parallel collaboration and a local team definition is available.

${profile.discipline.skillStateFragment()}
`;
}

export function installSkill(opts: SkillInstallOptions = {}): { file: string; backup: string | null } {
  const root = join(resolveCodexHome(opts.env, opts.codexHome), "skills");
  const dir = join(root, "teams");
  const file = join(dir, "SKILL.md");
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(root);
  const existing = manifest.entries.find(entry => entry.kind === "skill" && entry.file === file);
  let backup = existing?.backup ?? null;
  if (existsSync(file) && !existing) {
    if (!opts.force) throw new Error(`refusing to overwrite unmanaged skill file: ${file} (use --force to back it up first)`);
    backup = backupSkillFile(file, join(root, ".codex-teams-backups"));
  }
  const content = renderTeamsSkill();
  writeFileAtomic(file, content);
  const entries = manifest.entries.filter(entry => !(entry.kind === "skill" && entry.file === file));
  entries.push({
    team: "teams",
    scope: "skill",
    file,
    backup,
    hash: sha256(content),
    kind: "skill",
    installed_at: nowIso(opts.env),
  });
  writeManifest(root, { ...manifest, entries });
  return { file, backup };
}

export function uninstallSkill(opts: SkillInstallOptions = {}): { removed: string[]; restored: string[] } {
  const root = join(resolveCodexHome(opts.env, opts.codexHome), "skills");
  const manifest = readManifest(root);
  const removed: string[] = [];
  const restored: string[] = [];
  const keep: ManifestEntry[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== "skill" || entry.team !== "teams") {
      keep.push(entry);
      continue;
    }
    if (existsSync(entry.file)) {
      const currentHash = sha256(readFileSync(entry.file, "utf8"));
      if (currentHash !== entry.hash) throw new Error(`installed skill changed since install; refusing uninstall without manual review: ${entry.file}`);
      rmSync(entry.file, { force: true });
      removed.push(entry.file);
    }
    if (entry.backup && existsSync(entry.backup)) {
      copyFileSync(entry.backup, entry.file);
      restored.push(entry.file);
    }
  }
  writeManifest(root, { ...manifest, entries: keep });
  return { removed, restored };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
