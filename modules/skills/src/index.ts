import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findCodexBinary, getCodexVersion, writeJsonAtomic } from "./kit/index.js";

export type RootTarget = "user" | "legacy" | "repo" | string;

export type RootOptions = {
  home?: string;
  codexHome?: string;
  repoRoot?: string;
};

export type TargetOptions = RootOptions & {
  target?: RootTarget;
};

export type SkillTargets = {
  user: string;
  legacy: string;
  repo: string;
};

export type SkillValidation = {
  ok: boolean;
  dir: string;
  name?: string;
  description?: string;
  warnings: string[];
  agentsOpenaiYaml: boolean;
};

export type ListedSkill = SkillValidation & {
  root: keyof SkillTargets;
};

export type ListSkillsResult = {
  targets: SkillTargets;
  user: ListedSkill[];
  legacy: ListedSkill[];
  repo: ListedSkill[];
};

export type InstallOptions = TargetOptions & {
  force?: boolean;
};

export type InstallResult = {
  name: string;
  targetRoot: string;
  destDir: string;
  backupDir?: string;
  manifestPath: string;
};

export type RemoveOptions = TargetOptions & {
  forceForeign?: boolean;
};

export type RemoveResult = {
  name: string;
  targetRoot: string;
  destDir: string;
  backupDir: string;
  manifestPath: string;
};

export type ConvertReport = SkillValidation & {
  installable: boolean;
};

export type ProbeResult =
  | {
      skipped: true;
      ok: false;
      reason: string;
      codexBinary: null;
      skills: [];
    }
  | {
      skipped: false;
      ok: boolean;
      codexBinary: string;
      codexVersion: ReturnType<typeof getCodexVersion>;
      skills: Array<{ name: string; present: boolean }>;
      raw: string;
      stderr: string;
    };

export type DoctorResult = {
  ok: boolean;
  targets: SkillTargets;
  checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message: string }>;
  probe: ProbeResult;
};

export type RollbackResult =
  | {
      ok: false;
      missing: true;
      warnings: string[];
    }
  | {
      ok: boolean;
      missing: false;
      action: ManifestChange["action"];
      name: string;
      targetRoot: string;
      restored?: string;
      removed?: string;
      warnings: string[];
    };

type Frontmatter = {
  values: Record<string, string>;
  raw: string;
};

type ManifestRecord = {
  name: string;
  dir: string;
  sourceDir?: string;
  installedAt: string;
  updatedAt: string;
};

type ManifestChange = {
  action: "install" | "remove";
  name: string;
  timestamp: string;
  targetRoot: string;
  destDir: string;
  backupDir?: string;
  previousRecord?: ManifestRecord | null;
  foreign?: boolean;
};

type Manifest = {
  version: 1;
  installed: Record<string, ManifestRecord>;
  backups: Array<{ name: string; path: string; createdAt: string; action: string }>;
  lastChange?: ManifestChange;
};

const MANIFEST_NAME = ".codex-skills-manifest.json";
const BACKUPS_DIR = ".codex-skills-backups";
const SKILL_FILE = "SKILL.md";
const MAX_SCAN_DEPTH = 6;

export function resolveTargets(opts: RootOptions = {}): SkillTargets {
  const home = abs(opts.home ?? homedir());
  const codexHome = abs(opts.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex"));
  const repoRoot = abs(opts.repoRoot ?? process.cwd());
  return {
    user: join(home, ".agents", "skills"),
    legacy: join(codexHome, "skills"),
    repo: join(repoRoot, ".agents", "skills"),
  };
}

export function validateSkill(dir: string): SkillValidation {
  const skillDir = abs(dir);
  const warnings: string[] = [];
  const skillPath = join(skillDir, SKILL_FILE);
  const agentsOpenaiYaml = existsSync(join(skillDir, "agents", "openai.yaml"));

  if (!existsSync(skillPath)) {
    return { ok: false, dir: skillDir, warnings: [`${SKILL_FILE} is missing`], agentsOpenaiYaml };
  }

  let frontmatter: Frontmatter;
  try {
    frontmatter = parseFrontmatter(readFileSync(skillPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      dir: skillDir,
      warnings: [error instanceof Error ? error.message : String(error)],
      agentsOpenaiYaml,
    };
  }

  const name = frontmatter.values.name;
  const description = frontmatter.values.description;
  if (!name) warnings.push("frontmatter name is required");
  else if (name.length > 64) warnings.push("frontmatter name must be 64 characters or less");
  if (!description) warnings.push("frontmatter description is required");
  else if (description.length > 1024) warnings.push("frontmatter description must be 1024 characters or less");

  return {
    ok: warnings.length === 0,
    dir: skillDir,
    name,
    description,
    warnings,
    agentsOpenaiYaml,
  };
}

export function installSkill(sourceDir: string, opts: InstallOptions = {}): InstallResult {
  const validation = validateSkill(sourceDir);
  if (!validation.ok || !validation.name) {
    throw new Error(`Invalid skill: ${validation.warnings.join("; ")}`);
  }

  const targetRoot = resolveTargetRoot(opts);
  const destDir = join(targetRoot, validation.name);
  const manifestPath = join(targetRoot, MANIFEST_NAME);
  const manifest = loadManifest(manifestPath);
  const previousRecord = manifest.installed[validation.name] ?? null;
  let backupDir: string | undefined;

  if (existsSync(destDir)) {
    if (!opts.force) throw new Error(`Skill already exists at ${destDir}; pass force to replace it`);
    backupDir = backupDirectory(destDir, targetRoot, validation.name, "install");
    rmSync(destDir, { recursive: true, force: true });
  }

  mkdirSync(targetRoot, { recursive: true });
  cpSync(abs(sourceDir), destDir, { recursive: true, dereference: false, errorOnExist: false });
  const now = new Date().toISOString();
  manifest.installed[validation.name] = {
    name: validation.name,
    dir: destDir,
    sourceDir: abs(sourceDir),
    installedAt: previousRecord?.installedAt ?? now,
    updatedAt: now,
  };
  if (backupDir) manifest.backups.push({ name: validation.name, path: backupDir, createdAt: now, action: "install" });
  manifest.lastChange = {
    action: "install",
    name: validation.name,
    timestamp: now,
    targetRoot,
    destDir,
    backupDir,
    previousRecord,
  };
  saveManifest(manifestPath, manifest);
  return { name: validation.name, targetRoot, destDir, backupDir, manifestPath };
}

export function convertClaudeSkill(sourceDir: string): ConvertReport {
  const validation = validateSkill(sourceDir);
  const warnings = [...validation.warnings];
  const skillPath = join(abs(sourceDir), SKILL_FILE);
  if (existsSync(skillPath)) {
    try {
      const frontmatter = parseFrontmatter(readFileSync(skillPath, "utf8"));
      if (frontmatter.values["allowed-tools"]) {
        warnings.push("Claude frontmatter allowed-tools is not mapped to Codex permissions automatically");
      }
    } catch {
      // validateSkill already reported parser failures.
    }
  }
  return {
    ...validation,
    warnings,
    ok: validation.ok,
    installable: validation.ok,
  };
}

export function listSkills(opts: RootOptions = {}): ListSkillsResult {
  const targets = resolveTargets(opts);
  return {
    targets,
    user: scanRoot(targets.user, "user"),
    legacy: scanRoot(targets.legacy, "legacy"),
    repo: scanRoot(targets.repo, "repo"),
  };
}

export function removeSkill(name: string, opts: RemoveOptions = {}): RemoveResult {
  if (!name) throw new Error("removeSkill requires a skill name");
  const targetRoot = resolveTargetRoot(opts);
  const manifestPath = join(targetRoot, MANIFEST_NAME);
  const manifest = loadManifest(manifestPath);
  const record = manifest.installed[name] ?? null;
  if (!record && !opts.forceForeign) {
    throw new Error(`Refusing to remove ${name}; it is not tracked in ${manifestPath}`);
  }

  const destDir = record?.dir ?? join(targetRoot, name);
  if (!existsSync(destDir)) throw new Error(`Skill directory does not exist: ${destDir}`);
  const backupDir = backupDirectory(destDir, targetRoot, name, "remove");
  rmSync(destDir, { recursive: true, force: true });

  const now = new Date().toISOString();
  delete manifest.installed[name];
  manifest.backups.push({ name, path: backupDir, createdAt: now, action: "remove" });
  manifest.lastChange = {
    action: "remove",
    name,
    timestamp: now,
    targetRoot,
    destDir,
    backupDir,
    previousRecord: record,
    foreign: !record,
  };
  saveManifest(manifestPath, manifest);
  return { name, targetRoot, destDir, backupDir, manifestPath };
}

export function rollback(opts: TargetOptions = {}): RollbackResult {
  const chosen = resolveRollbackManifest(opts);
  if (!chosen) return { ok: false, missing: true, warnings: ["no manifest with a rollback entry was found"] };
  const { manifest, manifestPath, targetRoot } = chosen;
  const change = manifest.lastChange;
  if (!change) return { ok: false, missing: true, warnings: ["manifest has no lastChange entry"] };
  const warnings: string[] = [];

  if (change.action === "install") {
    if (existsSync(change.destDir)) rmSync(change.destDir, { recursive: true, force: true });
    if (change.backupDir) {
      cpSync(change.backupDir, change.destDir, { recursive: true, dereference: false });
      if (change.previousRecord) manifest.installed[change.name] = change.previousRecord;
      else delete manifest.installed[change.name];
    } else {
      delete manifest.installed[change.name];
    }
    manifest.lastChange = undefined;
    saveManifest(manifestPath, manifest);
    return { ok: warnings.length === 0, missing: false, action: change.action, name: change.name, targetRoot, removed: change.destDir, restored: change.backupDir, warnings };
  }

  if (!change.backupDir || !existsSync(change.backupDir)) {
    warnings.push("remove rollback backup is missing");
    return { ok: false, missing: false, action: change.action, name: change.name, targetRoot, warnings };
  }
  if (existsSync(change.destDir)) rmSync(change.destDir, { recursive: true, force: true });
  cpSync(change.backupDir, change.destDir, { recursive: true, dereference: false });
  if (change.previousRecord) manifest.installed[change.name] = change.previousRecord;
  manifest.lastChange = undefined;
  saveManifest(manifestPath, manifest);
  return { ok: true, missing: false, action: change.action, name: change.name, targetRoot, restored: change.destDir, warnings };
}

export function probe(opts: RootOptions = {}): ProbeResult {
  const bin = findCodexBinary();
  if (!bin) return { skipped: true, ok: false, reason: "codex binary not found on PATH", codexBinary: null, skills: [] };

  const targets = resolveTargets(opts);
  const listed = listSkills(opts);
  const names = [...listed.user, ...listed.legacy, ...listed.repo]
    .filter(skill => skill.ok && skill.name)
    .map(skill => skill.name!)
    .filter((name, index, all) => all.indexOf(name) === index);

  const result = spawnSync(bin, ["debug", "prompt-input", "probe"], {
    cwd: abs(opts.repoRoot ?? process.cwd()),
    env: {
      ...process.env,
      HOME: abs(opts.home ?? homedir()),
      CODEX_HOME: abs(opts.codexHome ?? process.env.CODEX_HOME ?? join(abs(opts.home ?? homedir()), ".codex")),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
  });
  const raw = `${result.stdout ?? ""}`;
  const stderr = `${result.stderr ?? ""}`;
  if (result.status !== 0 || result.error) {
    const reason = result.error ? result.error.message : stderr.trim();
    return {
      skipped: false,
      ok: false,
      codexBinary: bin,
      codexVersion: getCodexVersion(bin),
      skills: names.map(skillName => ({ name: skillName, present: false })),
      raw,
      stderr: reason,
    };
  }

  const haystack = normalizePromptInput(raw);
  const skills = names.map(skillName => ({ name: skillName, present: haystack.includes(skillName) }));
  return {
    skipped: false,
    ok: skills.every(skill => skill.present),
    codexBinary: bin,
    codexVersion: getCodexVersion(bin),
    skills,
    raw,
    stderr,
  };
}

export function doctor(opts: RootOptions = {}): DoctorResult {
  const targets = resolveTargets(opts);
  const checks: DoctorResult["checks"] = [];
  for (const [name, root] of Object.entries(targets)) {
    checks.push(checkRoot(name, root));
  }
  const bin = findCodexBinary();
  const version = getCodexVersion(bin);
  checks.push(
    bin
      ? { name: "codex", status: "ok", message: version?.raw ?? bin }
      : { name: "codex", status: "warn", message: "codex binary not found; probe will be skipped" },
  );
  const probeResult = probe(opts);
  if (probeResult.skipped) {
    checks.push({ name: "probe", status: "warn", message: probeResult.reason });
  } else if (probeResult.ok) {
    checks.push({ name: "probe", status: "ok", message: `${probeResult.skills.length} skill(s) visible in prompt-input` });
  } else {
    const missing = probeResult.skills.filter(skill => !skill.present).map(skill => skill.name).join(", ");
    checks.push({ name: "probe", status: "fail", message: missing ? `missing from prompt-input: ${missing}` : "prompt-input failed" });
  }
  return {
    ok: checks.every(check => check.status !== "fail"),
    targets,
    checks,
    probe: probeResult,
  };
}

function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must start with YAML frontmatter");
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter closing marker is missing");
  const raw = normalized.slice(4, end);
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\S[^:]*:\s*$/.test(trimmed)) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    values[match[1]!] = parseScalar(match[2] ?? "");
  }
  return { values, raw };
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  const commentStart = trimmed.indexOf(" #");
  return (commentStart >= 0 ? trimmed.slice(0, commentStart) : trimmed).trim();
}

function scanRoot(root: string, rootName: keyof SkillTargets): ListedSkill[] {
  if (!existsSync(root)) return [];
  const found: ListedSkill[] = [];
  scanDir(root, rootName, 0, found);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

function scanDir(dir: string, rootName: keyof SkillTargets, depth: number, found: ListedSkill[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (existsSync(join(dir, SKILL_FILE))) {
    found.push({ ...validateSkill(dir), root: rootName });
    return;
  }
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    scanDir(join(dir, entry.name), rootName, depth + 1, found);
  }
}

function resolveTargetRoot(opts: TargetOptions): string {
  const target = opts.target ?? "user";
  const targets = resolveTargets(opts);
  if (target === "user" || target === "legacy" || target === "repo") return targets[target];
  return abs(target);
}

function loadManifest(path: string): Manifest {
  if (!existsSync(path)) return emptyManifest();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (parsed.version === 1 && parsed.installed && parsed.backups) return parsed;
  } catch {
    // Corrupt manifests are treated as absent instead of blocking repair installs.
  }
  return emptyManifest();
}

function saveManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, manifest);
}

function emptyManifest(): Manifest {
  return { version: 1, installed: {}, backups: [] };
}

function backupDirectory(dir: string, targetRoot: string, name: string, action: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const backupDir = join(targetRoot, BACKUPS_DIR, `${safeName}.${action}.${stamp}.${process.pid}.bak`);
  mkdirSync(dirname(backupDir), { recursive: true });
  cpSync(dir, backupDir, { recursive: true, dereference: false });
  return backupDir;
}

function resolveRollbackManifest(opts: TargetOptions): { manifest: Manifest; manifestPath: string; targetRoot: string } | null {
  if (opts.target) {
    const targetRoot = resolveTargetRoot(opts);
    const manifestPath = join(targetRoot, MANIFEST_NAME);
    const manifest = loadManifest(manifestPath);
    return manifest.lastChange ? { manifest, manifestPath, targetRoot } : null;
  }

  const targets = resolveTargets(opts);
  const candidates = Object.values(targets)
    .map(targetRoot => {
      const manifestPath = join(targetRoot, MANIFEST_NAME);
      const manifest = loadManifest(manifestPath);
      return manifest.lastChange ? { manifest, manifestPath, targetRoot } : null;
    })
    .filter((candidate): candidate is { manifest: Manifest; manifestPath: string; targetRoot: string } => candidate !== null);

  return candidates.sort((a, b) => (b.manifest.lastChange?.timestamp ?? "").localeCompare(a.manifest.lastChange?.timestamp ?? "")).at(0) ?? null;
}

function normalizePromptInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function checkRoot(name: string, root: string): DoctorResult["checks"][number] {
  try {
    if (existsSync(root)) {
      const stat = statSync(root);
      if (!stat.isDirectory()) return { name, status: "fail", message: `${root} exists but is not a directory` };
      accessSync(root, fsConstants.R_OK | fsConstants.W_OK);
      return { name, status: "ok", message: root };
    }
    const parent = dirname(root);
    if (existsSync(parent)) accessSync(parent, fsConstants.W_OK);
    return { name, status: "warn", message: `${root} does not exist yet` };
  } catch (error) {
    return { name, status: "fail", message: error instanceof Error ? error.message : String(error) };
  }
}

function abs(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}
