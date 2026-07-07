import { mkdir, readFile, rename, copyFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashString } from "./logging.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PORT,
  DEFAULT_PROVIDER_ID,
  type InstallOptions,
  type InstallResult,
  type UninstallOptions,
  type UninstallResult,
} from "./types.js";

const BEGIN = "# BEGIN codex-modules with-claude";
const END = "# END codex-modules with-claude";
const BOUNDARY_TABLE = "[codex_modules.with_claude_boundary]";

type Manifest = {
  module: "with-claude";
  providerId: string;
  model: string;
  baseUrl: string;
  backupPath: string;
  setDefault: boolean;
  preInstallTopLevel: Record<"model" | "model_provider", { present: boolean; value?: string }>;
  installedTopLevel: { model: string; model_provider: string };
  postInstallConfigHash: string;
  sentinelRangeHash: string;
  installedAt: string;
};

export async function installProvider(options: InstallOptions): Promise<InstallResult> {
  const codexHome = requireCodexHome(options.codexHome);
  const providerId = validateProviderId(options.providerId ?? DEFAULT_PROVIDER_ID);
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}/v1`;
  const configPath = join(codexHome, "config.toml");
  const manifestPath = manifestPathFor(codexHome);
  await mkdir(codexHome, { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });

  const original = await readExisting(configPath);
  const backupPath = `${configPath}.codex-with-claude.${timestamp()}.bak`;
  await writeFile(backupPath, original, "utf8");

  const withoutOld = removeBoundary(removeSentinel(original));
  const preInstallTopLevel = {
    model: readTopLevel(withoutOld, "model"),
    model_provider: readTopLevel(withoutOld, "model_provider"),
  };
  const block = providerBlock(providerId, baseUrl);
  let next = appendBlock(withoutOld, block);
  next = appendBlock(next, boundaryBlock());
  if (options.setDefault) {
    next = upsertTopLevel(next, "model", model);
    next = upsertTopLevel(next, "model_provider", providerId);
  }
  await writeFile(configPath, next, "utf8");
  const manifest: Manifest = {
    module: "with-claude",
    providerId,
    model,
    baseUrl,
    backupPath,
    setDefault: Boolean(options.setDefault),
    preInstallTopLevel,
    installedTopLevel: { model, model_provider: providerId },
    postInstallConfigHash: hashString(next),
    sentinelRangeHash: hashString(block),
    installedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ok: true, codexHome, configPath, manifestPath, backupPath, providerId, model, baseUrl, setDefault: Boolean(options.setDefault) };
}

export async function uninstallProvider(options: UninstallOptions): Promise<UninstallResult> {
  const codexHome = requireCodexHome(options.codexHome);
  const configPath = join(codexHome, "config.toml");
  const manifestPath = manifestPathFor(codexHome);
  if (options.restoreBackup) {
    await copyFile(options.restoreBackup, configPath);
    return { ok: true, codexHome, configPath, backupPath: options.restoreBackup };
  }
  if (!existsSync(manifestPath)) {
    return { ok: false, codexHome, configPath, manifestPath, conflict: "install manifest not found" };
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const current = await readExisting(configPath);
  const block = extractSentinel(current);
  if (!block) return { ok: false, codexHome, configPath, manifestPath, backupPath: manifest.backupPath, conflict: "sentinel block not found" };
  if (hashString(block) !== manifest.sentinelRangeHash) {
    return { ok: false, codexHome, configPath, manifestPath, backupPath: manifest.backupPath, conflict: "sentinel block changed after install" };
  }
  let next = removeBoundary(removeSentinel(current));
  if (manifest.setDefault) {
    next = restoreTopLevel(next, "model", manifest.installedTopLevel.model, manifest.preInstallTopLevel.model);
    next = restoreTopLevel(next, "model_provider", manifest.installedTopLevel.model_provider, manifest.preInstallTopLevel.model_provider);
  }
  await writeFile(configPath, next, "utf8");
  await rename(manifestPath, `${manifestPath}.uninstalled.${timestamp()}`);
  return { ok: true, codexHome, configPath, manifestPath, backupPath: manifest.backupPath };
}

export function requireCodexHome(value?: string): string {
  const codexHome = value ?? process.env.CODEX_HOME;
  if (!codexHome) throw new Error("--codex-home or CODEX_HOME is required; ~/.codex fallback is intentionally disabled.");
  return codexHome;
}

export function manifestPathFor(codexHome: string): string {
  return join(codexHome, "codex-modules", "with-claude-install.json");
}

function providerBlock(providerId: string, baseUrl: string): string {
  return [
    BEGIN,
    `[model_providers.${providerId}]`,
    'name = "With Claude"',
    `base_url = "${escapeToml(baseUrl)}"`,
    'wire_api = "responses"',
    END,
    "",
  ].join("\n");
}

function boundaryBlock(): string {
  // Keeps later Codex-managed tables from being attached to the provider
  // block's trailing comments by TOML-preserving rewrites.
  return `${BOUNDARY_TABLE}\n`;
}

function appendBlock(config: string, block: string): string {
  const trimmed = config.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}`;
}

function removeSentinel(config: string): string {
  const escapedBegin = escapeRegExp(BEGIN);
  const escapedEnd = escapeRegExp(END);
  return config.replace(new RegExp(`\\n?${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`, "m"), "\n").replace(/\n{3,}/g, "\n\n");
}

function removeBoundary(config: string): string {
  return config
    .replace(new RegExp(`\\n?${escapeRegExp(BOUNDARY_TABLE)}\\n?`, "m"), "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function extractSentinel(config: string): string | undefined {
  const start = config.indexOf(BEGIN);
  const end = config.indexOf(END);
  if (start < 0 || end < start) return undefined;
  return `${config.slice(start, end + END.length)}\n`;
}

function readTopLevel(config: string, key: "model" | "model_provider"): { present: boolean; value?: string } {
  const match = config.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? { present: true, value: match[1] } : { present: false };
}

function upsertTopLevel(config: string, key: "model" | "model_provider", value: string): string {
  const line = `${key} = "${escapeToml(value)}"`;
  const re = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m");
  if (re.test(config)) return config.replace(re, line);
  return `${line}\n${config}`;
}

function restoreTopLevel(config: string, key: "model" | "model_provider", installedValue: string, previous: { present: boolean; value?: string }): string {
  const re = new RegExp(`^${key}\\s*=\\s*"${escapeRegExp(escapeToml(installedValue))}"\\n?`, "m");
  if (!re.test(config)) return config;
  if (previous.present) return config.replace(re, `${key} = "${escapeToml(previous.value ?? "")}"\n`);
  return config.replace(re, "");
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateProviderId(value: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error("providerId must be a TOML bare key segment: letters, digits, underscores, or dashes, and not start with a dash");
  }
  return value;
}
