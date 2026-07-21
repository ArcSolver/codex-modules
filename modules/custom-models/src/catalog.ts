// Adapted from opencodex src/codex-catalog.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { CATALOG_FILENAME, CODEX_GPT5_IDENTITY_LINE, MODELS_CACHE_FILENAME } from "./constants.js";
import { atomicWriteFile } from "./fs.js";
import { CODEX_REASONING_LEVELS, sanitizeCodexReasoningEfforts } from "./reasoning.js";
import { readRootTomlString, resolveFromCodexHome, samePath } from "./toml.js";
import type { CustomModelSpec, RawCatalog, RawEntry } from "./types.js";

type ExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
    shell?: boolean;
  },
) => string;

export function defaultCatalogPath(codexHome: string): string {
  return join(codexHome, CATALOG_FILENAME);
}

export function modelsCachePath(codexHome: string): string {
  return join(codexHome, MODELS_CACHE_FILENAME);
}

export function parseCatalogJson(raw: string): RawCatalog | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return { models: parsed as RawEntry[] };
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)) {
      const object = parsed as RawCatalog;
      return { ...object, models: [...object.models] };
    }
    return null;
  } catch {
    return null;
  }
}

export function readCatalog(path: string): RawCatalog | null {
  try {
    if (!existsSync(path)) return null;
    return parseCatalogJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeCatalog(path: string, catalog: RawCatalog): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, JSON.stringify(catalog, null, 2) + "\n");
}

export function findNativeTemplate(catalog: RawCatalog | null): RawEntry | null {
  return catalog?.models.find(
    entry => typeof entry.slug === "string" && !entry.slug.includes("/") && "base_instructions" in entry,
  ) ?? null;
}

export function readActiveCatalogPath(codexHome: string, configContent: string): string | null {
  const root = readRootTomlString(configContent, "model_catalog_json");
  return root ? resolveFromCodexHome(codexHome, root) : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cloneCatalogEntry(entry: RawEntry): RawEntry {
  return JSON.parse(JSON.stringify(entry)) as RawEntry;
}

function codexCommandCandidates(): string[] {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  const candidates = envPath ? [envPath] : [];
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, "codex.exe"), join(dir, "codex.cmd"));
    }
  }
  candidates.push("codex");
  return unique(candidates);
}

export function codexExecInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; shell: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return { file: `"${command.replace(/"/g, "")}"`, shell: true };
  }
  return { file: command, shell: false };
}

function runCodexDebugModels(command: string, execFile: ExecFile): string {
  const invocation = codexExecInvocation(command);
  return execFile(invocation.file, ["debug", "models", "--bundled"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    shell: invocation.shell,
  });
}

export function loadBundledCodexCatalog(execFile: ExecFile = execFileSync as unknown as ExecFile): RawCatalog | null {
  for (const command of codexCommandCandidates()) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile));
      if (catalog && findNativeTemplate(catalog)) return catalog;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function loadTemplateCatalog(codexHome: string, configContent: string, targetCatalogPath: string): RawCatalog | null {
  const activeCatalogPath = readActiveCatalogPath(codexHome, configContent);
  return readCatalog(targetCatalogPath)
    ?? (activeCatalogPath ? readCatalog(activeCatalogPath) : null)
    ?? readCatalog(modelsCachePath(codexHome))
    ?? loadBundledCodexCatalog();
}

function ensureAutoCompactTokenLimit(entry: RawEntry): RawEntry {
  if (
    typeof entry.context_window === "number"
    && entry.context_window > 0
    && typeof entry.auto_compact_token_limit !== "number"
  ) {
    entry.auto_compact_token_limit = Math.floor(entry.context_window * 0.9);
  }
  return entry;
}

function ensureStrictCatalogFields(entry: RawEntry): RawEntry {
  if (typeof entry.supports_reasoning_summaries !== "boolean") entry.supports_reasoning_summaries = true;
  if (typeof entry.default_reasoning_summary !== "string") entry.default_reasoning_summary = "none";
  if (typeof entry.support_verbosity !== "boolean") entry.support_verbosity = true;
  if (typeof entry.default_verbosity !== "string") entry.default_verbosity = "low";
  if (typeof entry.apply_patch_tool_type !== "string") entry.apply_patch_tool_type = "freeform";
  if (!entry.truncation_policy || typeof entry.truncation_policy !== "object" || Array.isArray(entry.truncation_policy)) {
    entry.truncation_policy = { mode: "tokens", limit: 10000 };
  }
  if (typeof entry.supports_parallel_tool_calls !== "boolean") entry.supports_parallel_tool_calls = true;
  if (typeof entry.supports_image_detail_original !== "boolean") entry.supports_image_detail_original = false;
  if (!Array.isArray(entry.experimental_supported_tools)) entry.experimental_supported_tools = [];
  if (!Array.isArray(entry.input_modalities)) entry.input_modalities = ["text"];
  const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;
  entry.context_window = contextWindow;
  if (typeof entry.max_context_window !== "number" || entry.max_context_window <= 0 || entry.max_context_window > contextWindow) {
    entry.max_context_window = contextWindow;
  }
  if (typeof entry.effective_context_window_percent !== "number") entry.effective_context_window_percent = 95;
  if (typeof entry.comp_hash !== "string") entry.comp_hash = "codex-custom-models";
  return ensureAutoCompactTokenLimit(entry);
}

export function normalizeRoutedCatalogEntry(entry: RawEntry): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  entry.supports_parallel_tool_calls = false;
  return ensureStrictCatalogFields(entry);
}

function applyReasoningLevels(entry: RawEntry, effortsOverride?: string[]): void {
  const efforts = sanitizeCodexReasoningEfforts(effortsOverride) ?? CODEX_REASONING_LEVELS.map(level => level.effort);
  const byEffort = new Map(
    (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((level: { effort?: string }) => [level.effort, level]),
  );
  entry.supported_reasoning_levels = efforts.map(effort => {
    const native = byEffort.get(effort);
    if (native) return native;
    return CODEX_REASONING_LEVELS.find(level => level.effort === effort) ?? { effort, description: `${effort} reasoning` };
  });
  if (efforts.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  entry.default_reasoning_level = efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
}

function applyModelMetadata(entry: RawEntry, model: CustomModelSpec): void {
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    entry.context_window = model.contextWindow;
    entry.max_context_window = model.contextWindow;
    entry.auto_compact_token_limit = Math.floor(model.contextWindow * 0.9);
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input_modalities = [...model.inputModalities];
  }
}

export function routedSlug(providerId: string, modelSlug: string): string {
  return `${providerId}/${modelSlug}`;
}

export function deriveCustomEntry(template: RawEntry, providerId: string, providerName: string | undefined, model: CustomModelSpec): RawEntry {
  const slug = routedSlug(providerId, model.slug);
  const entry = cloneCatalogEntry(template);
  entry.slug = slug;
  entry.display_name = model.displayName ?? slug;
  entry.description = model.description ?? `Registered by codex-custom-models via ${providerName ?? providerId}.`;
  entry.priority = typeof model.priority === "number" ? model.priority : 5;
  entry.visibility = "list";
  if ("upgrade" in entry) entry.upgrade = null;
  delete entry.availability_nux;
  if (typeof entry.base_instructions === "string") {
    entry.base_instructions = entry.base_instructions.replace(
      CODEX_GPT5_IDENTITY_LINE,
      `You are a coding agent powered by the ${model.slug} model. Do not claim to be GPT-5 or made by OpenAI.`,
    );
  }
  applyReasoningLevels(entry, model.reasoningEfforts);
  applyModelMetadata(entry, model);
  return normalizeRoutedCatalogEntry(entry);
}

export function mergeCustomEntries(baseCatalog: RawCatalog, ownedSlugsForProvider: string[], entries: RawEntry[]): RawCatalog {
  const remove = new Set(ownedSlugsForProvider);
  for (const entry of entries) {
    if (typeof entry.slug === "string") remove.add(entry.slug);
  }
  const kept = baseCatalog.models.filter(entry => !(typeof entry.slug === "string" && remove.has(entry.slug)));
  const models = [...kept, ...entries].map(entry => ensureStrictCatalogFields(cloneCatalogEntry(entry)));
  return { ...baseCatalog, models };
}

export function removeCatalogSlugs(catalog: RawCatalog, slugs: string[]): { catalog: RawCatalog; removed: string[] } {
  const remove = new Set(slugs);
  const removed: string[] = [];
  const kept = catalog.models.filter(entry => {
    if (typeof entry.slug === "string" && remove.has(entry.slug)) {
      removed.push(entry.slug);
      return false;
    }
    return true;
  });
  return { catalog: { ...catalog, models: kept }, removed };
}

export function invalidateModelsCache(codexHome: string, catalogPath: string): void {
  const catalog = readCatalog(catalogPath);
  if (!catalog) return;
  const wrapper = {
    fetched_at: "2000-01-01T00:00:00Z",
    client_version: "0.0.0",
    models: catalog.models,
  };
  atomicWriteFile(modelsCachePath(codexHome), JSON.stringify(wrapper, null, 2) + "\n");
}

export function isDefaultModuleCatalogPath(codexHome: string, path: string): boolean {
  return samePath(path, defaultCatalogPath(codexHome));
}

export function resolveCatalogPath(codexHome: string, requested?: string): string {
  return requested ? resolve(codexHome, requested) : defaultCatalogPath(codexHome);
}
