import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { InstallScope, ManifestEntry, TeamDef, TeamsManifest } from "./types.js";
import { assembleDeveloperInstructions } from "./prompt.js";
import { memberAgentName, parseTeamJson, resolveMemberModel, resolveMemberSandbox } from "./team.js";
import { renderToml } from "./toml.js";
import { nowIso, readJson, writeFileAtomic, writeJsonAtomic } from "./state.js";

export type InstallOptions = {
  codexHome?: string;
  scope?: InstallScope;
  cwd?: string;
  force?: boolean;
  skipModelCheck?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export type InstallResult = {
  team: string;
  scope: InstallScope;
  targetRoot: string;
  files: string[];
  warnings: string[];
};

export type UninstallResult = {
  team: string;
  scope: InstallScope;
  targetRoot: string;
  removed: string[];
  restored: string[];
};

export function installTeam(teamPath: string, opts: InstallOptions = {}): InstallResult {
  const team = parseTeamJson(teamPath);
  return installTeamDef(team, opts);
}

export function installTeamDef(team: TeamDef, opts: InstallOptions = {}): InstallResult {
  const scope = opts.scope ?? "user";
  const targetRoot = resolveAgentsRoot(scope, opts);
  mkdirSync(targetRoot, { recursive: true });
  const warnings: string[] = [];
  if (scope === "project") {
    warnings.push("project scope requires a trusted Codex project; config.toml is not modified automatically");
  }
  if (!opts.skipModelCheck) warnings.push(...checkModels(team, opts));

  const manifest = readManifest(targetRoot);
  const installedAt = nowIso(opts.env);
  const nextEntries = manifest.entries.filter(entry => !(entry.team === team.name && entry.kind === "agent"));
  const files: string[] = [];

  for (const member of team.members) {
    const file = join(targetRoot, `${memberAgentName(team, member)}.toml`);
    const content = renderAgentToml(team, member.name);
    const existing = manifest.entries.find(entry => entry.file === file && entry.kind === "agent");
    let backup: string | null = existing?.backup ?? null;
    if (existsSync(file) && !existing) {
      if (!opts.force) throw new Error(`refusing to overwrite unmanaged agent file: ${file} (use --force to back it up first)`);
      backup = backupFile(file, join(targetRoot, ".codex-teams-backups"));
    }
    writeFileAtomic(file, content);
    files.push(file);
    nextEntries.push({
      team: team.name,
      scope,
      file,
      backup,
      hash: sha256(content),
      kind: "agent",
      member: member.name,
      installed_at: installedAt,
    });
  }

  writeManifest(targetRoot, { ...manifest, entries: nextEntries });
  return { team: team.name, scope, targetRoot, files, warnings };
}

export function uninstallTeam(team: string, opts: InstallOptions = {}): UninstallResult {
  const scope = opts.scope ?? "user";
  const targetRoot = resolveAgentsRoot(scope, opts);
  const manifest = readManifest(targetRoot);
  const removed: string[] = [];
  const restored: string[] = [];
  const keep: ManifestEntry[] = [];

  for (const entry of manifest.entries) {
    if (entry.team !== team || entry.kind !== "agent") {
      keep.push(entry);
      continue;
    }
    if (existsSync(entry.file)) {
      const currentHash = sha256(readFileSync(entry.file, "utf8"));
      if (currentHash !== entry.hash) throw new Error(`installed file changed since install; refusing uninstall without manual review: ${entry.file}`);
      rmSync(entry.file, { force: true });
      removed.push(entry.file);
    }
    if (entry.backup && existsSync(entry.backup)) {
      copyFileSync(entry.backup, entry.file);
      restored.push(entry.file);
    }
  }

  writeManifest(targetRoot, { ...manifest, entries: keep });
  return { team, scope, targetRoot, removed, restored };
}

export function renderAgentToml(team: TeamDef, memberName: string): string {
  const member = team.members.find(item => item.name === memberName);
  if (!member) throw new Error(`unknown member: ${memberName}`);
  const agentName = memberAgentName(team, member);
  return renderToml({
    name: agentName,
    description: member.focus,
    model: resolveMemberModel(team, member),
    sandbox_mode: resolveMemberSandbox(team, member),
    nickname_candidates: [member.name],
    developer_instructions: assembleDeveloperInstructions(team, member),
  });
}

export function resolveCodexHome(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env, explicit?: string): string {
  return resolve(explicit ?? env.CODEX_HOME ?? join(homedir(), ".codex"));
}

export function resolveAgentsRoot(scope: InstallScope, opts: InstallOptions = {}): string {
  if (scope === "project") return resolve(opts.cwd ?? process.cwd(), ".codex", "agents");
  return join(resolveCodexHome(opts.env, opts.codexHome), "agents");
}

export function manifestPath(targetRoot: string): string {
  return join(targetRoot, ".codex-teams-manifest.json");
}

export function readManifest(targetRoot: string): TeamsManifest {
  const path = manifestPath(targetRoot);
  if (!existsSync(path)) return { version: 1, owner: "@codex-modules/teams", entries: [] };
  const manifest = readJson<TeamsManifest>(path);
  if (manifest.version !== 1 || manifest.owner !== "@codex-modules/teams" || !Array.isArray(manifest.entries)) {
    throw new Error(`unsupported teams manifest format: ${path}`);
  }
  return manifest;
}

export function writeManifest(targetRoot: string, manifest: TeamsManifest): void {
  mkdirSync(targetRoot, { recursive: true });
  writeJsonAtomic(manifestPath(targetRoot), manifest);
}

export function findCodexBinary(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return null;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

export function listInstalledTeams(targetRoot: string): string[] {
  return [...new Set(readManifest(targetRoot).entries.filter(entry => entry.kind === "agent").map(entry => entry.team))].sort();
}

function checkModels(team: TeamDef, opts: InstallOptions): string[] {
  const warnings: string[] = [];
  const bin = findCodexBinary(opts.env);
  if (!bin) return ["codex binary not found; skipping model catalog preflight"];
  const result = spawnSync(bin, ["debug", "models"], {
    env: { ...process.env, ...(opts.env ?? {}), CODEX_HOME: resolveCodexHome(opts.env, opts.codexHome) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    return [`codex debug models unavailable; continuing without strict model preflight${reason ? ` (${reason})` : ""}`];
  }
  const catalog = parseModelCatalog(result.stdout);
  if (catalog.length === 0) return ["codex debug models returned no parseable catalog entries; continuing"];
  const available = new Set(catalog);
  for (const member of team.members) {
    const model = resolveMemberModel(team, member);
    if (!available.has(model)) throw new Error(`model ${model} for member ${member.name} is not in codex debug models catalog`);
  }
  return warnings;
}

function parseModelCatalog(stdout: string): string[] {
  const values = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    for (const match of line.matchAll(/\b(?:gpt|o)[A-Za-z0-9_.:-]+\b/g)) values.add(match[0]);
  }
  return [...values];
}

function backupFile(file: string, backupDir: string): string {
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `${basename(file)}.${new Date().toISOString().replace(/[:.]/g, "-")}.${process.pid}.bak`);
  copyFileSync(file, backup);
  try {
    chmodSync(backup, statSync(file).mode & 0o777);
  } catch {
    // best effort
  }
  return backup;
}

export function backupSkillFile(file: string, backupDir: string): string {
  return backupFile(file, backupDir);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
