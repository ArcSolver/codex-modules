import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  defaultCatalogPath,
  deriveCustomEntry,
  findNativeTemplate,
  invalidateModelsCache,
  isDefaultModuleCatalogPath,
  loadTemplateCatalog,
  mergeCustomEntries,
  modelsCachePath,
  readCatalog,
  removeCatalogSlugs,
  resolveCatalogPath,
  routedSlug,
  writeCatalog,
} from "./catalog.js";
import { CONFIG_FILENAME } from "./constants.js";
import {
  buildProviderTableBlock,
  hasOwnedProviderTable,
  hasProviderTable,
  injectProviderTable,
  removeRootModelCatalogIf,
  removeRootModelProviderIf,
  rootModelCatalogPath,
  rootModelProvider,
  setRootModelCatalogPath,
  setRootModelProvider,
  stripProviderSection,
} from "./config-transform.js";
import { resolveCodexHomeDir } from "./codex-home.js";
import { atomicWriteFile } from "./fs.js";
import {
  createTransaction,
  loadState,
  markTransactionAfter,
  modulePaths,
  removeStateIfEmpty,
  rollbackFromJournal,
  saveState,
  type ModulePaths,
  type ModuleState,
} from "./state.js";
import { resolveFromCodexHome, samePath } from "./toml.js";
import type {
  CustomModelSpec,
  DoctorResult,
  ListResult,
  Plan,
  PlanConflict,
  RegisterOptions,
  RegisterResult,
  RemoveResult,
  RollbackResult,
} from "./types.js";
import { validateBaseUrl, validateEnvHttpHeaders, validateModelSlug, validateProviderId } from "./validate.js";

type ResolvedRegister = {
  options: RegisterOptions;
  codexHome: string;
  paths: ModulePaths;
  configPath: string;
  catalogPath: string;
  cachePath: string;
  profilePath?: string;
  state: ModuleState;
};

function readConfig(configPath: string): string {
  if (!existsSync(configPath)) {
    throw new Error(`Codex config not found at ${configPath}. Run Codex once or pass --codex-home to an initialized sandbox.`);
  }
  return readFileSync(configPath, "utf8");
}

function normalizeModels(models: CustomModelSpec[]): CustomModelSpec[] {
  if (!Array.isArray(models) || models.length === 0) throw new Error("at least one --model is required");
  const seen = new Set<string>();
  return models.map(model => {
    validateModelSlug(model.slug);
    if (seen.has(model.slug)) throw new Error(`duplicate model slug "${model.slug}"`);
    seen.add(model.slug);
    if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`contextWindow for "${model.slug}" must be a positive integer`);
    }
    if (model.priority !== undefined && !Number.isFinite(model.priority)) {
      throw new Error(`priority for "${model.slug}" must be a finite number`);
    }
    return { ...model };
  });
}

function normalizeRegisterOptions(options: RegisterOptions): RegisterOptions {
  validateProviderId(options.providerId);
  validateBaseUrl(options.baseUrl);
  validateEnvHttpHeaders(options.envHttpHeaders);
  if (options.profileName && !/^[A-Za-z0-9._-]+$/.test(options.profileName)) {
    throw new Error("profileName must use only letters, numbers, dot, underscore, or hyphen");
  }
  return {
    ...options,
    providerName: options.providerName?.trim() || undefined,
    baseUrl: options.baseUrl.trim(),
    requiresOpenaiAuth: options.requiresOpenaiAuth ?? true,
    models: normalizeModels(options.models),
  };
}

function resolveRegister(options: RegisterOptions): ResolvedRegister {
  const normalized = normalizeRegisterOptions(options);
  const codexHome = resolveCodexHomeDir(normalized.codexHome);
  const paths = modulePaths(codexHome, normalized.stateDir);
  const profilePath = normalized.profileName ? join(codexHome, `${normalized.profileName}.config.toml`) : undefined;
  return {
    options: normalized,
    codexHome,
    paths,
    configPath: join(codexHome, CONFIG_FILENAME),
    catalogPath: resolveCatalogPath(codexHome, normalized.catalogPath),
    cachePath: modelsCachePath(codexHome),
    profilePath,
    state: loadState(paths),
  };
}

function stateOwnsCatalog(state: ModuleState, path: string): boolean {
  return Object.values(state.providers).some(provider => samePath(provider.catalogPath, path));
}

function isModuleOwnedCatalog(codexHome: string, state: ModuleState, targetCatalogPath: string, candidate: string): boolean {
  return samePath(candidate, targetCatalogPath)
    || isDefaultModuleCatalogPath(codexHome, candidate)
    || stateOwnsCatalog(state, candidate);
}

function planConflicts(resolved: ResolvedRegister, configContent: string): PlanConflict[] {
  const { options, codexHome, catalogPath, configPath, state } = resolved;
  const conflicts: PlanConflict[] = [];
  const existingProvider = rootModelProvider(configContent);
  if (existingProvider && existingProvider !== options.providerId && !options.force) {
    conflicts.push({
      code: "root-model-provider-conflict",
      path: configPath,
      message: `config.toml already has root model_provider = "${existingProvider}". Re-run with --force to leave or replace it explicitly.`,
    });
  }
  const existingCatalog = rootModelCatalogPath(configContent);
  if (existingCatalog) {
    const resolvedCatalog = resolveFromCodexHome(codexHome, existingCatalog);
    if (!isModuleOwnedCatalog(codexHome, state, catalogPath, resolvedCatalog) && !options.force) {
      conflicts.push({
        code: "root-model-catalog-conflict",
        path: configPath,
        message: `config.toml already has root model_catalog_json = "${existingCatalog}", which is not owned by codex-custom-models. Re-run with --force to switch to ${catalogPath}.`,
      });
    }
  }
  if (hasProviderTable(configContent, options.providerId) && !hasOwnedProviderTable(configContent, options.providerId) && !options.force) {
    conflicts.push({
      code: "provider-table-conflict",
      path: configPath,
      message: `config.toml already has a non-owned [model_providers.${options.providerId}] table. Re-run with --force to replace that table.`,
    });
  }
  return conflicts;
}

export async function planRegister(options: RegisterOptions): Promise<Plan> {
  const resolved = resolveRegister(options);
  const routedSlugs = resolved.options.models.map(model => routedSlug(resolved.options.providerId, model.slug));
  const changes = [
    `write catalog ${resolved.catalogPath}`,
    `set root model_catalog_json to ${resolved.catalogPath}`,
    `write provider table for ${resolved.options.providerId}`,
    `rewrite ${resolved.cachePath} as an expired models cache wrapper`,
  ];
  if (resolved.options.setDefaultProvider) changes.push(`set root model_provider to ${resolved.options.providerId}`);
  if (resolved.profilePath) changes.push(`write profile ${resolved.profilePath}`);

  let conflicts: PlanConflict[] = [];
  if (!existsSync(resolved.configPath)) {
    conflicts = [{
      code: "missing-config",
      path: resolved.configPath,
      message: `Codex config not found at ${resolved.configPath}. Run Codex once before registering custom models.`,
    }];
  } else {
    conflicts = planConflicts(resolved, readConfig(resolved.configPath));
  }

  return {
    ok: conflicts.length === 0,
    dryRun: resolved.options.dryRun === true,
    codexHome: resolved.codexHome,
    stateDir: resolved.paths.stateDir,
    configPath: resolved.configPath,
    catalogPath: resolved.catalogPath,
    cachePath: resolved.cachePath,
    providerId: resolved.options.providerId,
    routedSlugs,
    changes,
    conflicts,
  };
}

function updateProviderState(state: ModuleState, options: RegisterOptions, catalogPath: string, profilePath: string | undefined, routedSlugs: string[]): ModuleState {
  const now = new Date().toISOString();
  const existing = state.providers[options.providerId];
  const modelsBySlug = new Map<string, CustomModelSpec>();
  for (const model of existing?.models ?? []) modelsBySlug.set(model.slug, model);
  for (const model of options.models) modelsBySlug.set(model.slug, model);
  const owned = new Set(existing?.ownedSlugs ?? []);
  for (const slug of routedSlugs) owned.add(slug);
  return {
    ...state,
    providers: {
      ...state.providers,
      [options.providerId]: {
        providerName: options.providerName,
        baseUrl: options.baseUrl,
        catalogPath,
        profileName: options.profileName ?? existing?.profileName,
        profilePath: profilePath ?? existing?.profilePath,
        ownedSlugs: [...owned].sort(),
        models: [...modelsBySlug.values()],
        updatedAt: now,
      },
    },
  };
}

function applyRegisterConfig(content: string, options: RegisterOptions, catalogPath: string): string {
  let out = stripProviderSection(content, options.providerId, options.force === true);
  out = setRootModelCatalogPath(out, catalogPath);
  if (options.setDefaultProvider) out = setRootModelProvider(out, options.providerId);
  out = injectProviderTable(out, {
    providerId: options.providerId,
    providerName: options.providerName,
    baseUrl: options.baseUrl,
    requiresOpenaiAuth: options.requiresOpenaiAuth,
    envHttpHeaders: options.envHttpHeaders,
  }, options.force === true);
  return out;
}

function buildProfileFile(options: RegisterOptions, catalogPath: string): string {
  const lines = [
    `# codex-custom-models profile - use with: codex --profile ${options.profileName}`,
    `model_provider = "${options.providerId}"`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    buildProviderTableBlock({
      providerId: options.providerId,
      providerName: options.providerName,
      baseUrl: options.baseUrl,
      requiresOpenaiAuth: options.requiresOpenaiAuth,
      envHttpHeaders: options.envHttpHeaders,
    }).trimEnd(),
    "",
  ];
  return lines.join("\n");
}

export async function registerModels(options: RegisterOptions): Promise<RegisterResult> {
  const resolved = resolveRegister(options);
  const plan = await planRegister(resolved.options);
  if (plan.conflicts.length > 0) {
    throw new Error(plan.conflicts.map(conflict => conflict.message).join("\n"));
  }
  if (resolved.options.dryRun) {
    return { applied: false, plan, added: plan.routedSlugs, catalogPath: resolved.catalogPath, configPath: resolved.configPath, cachePath: resolved.cachePath };
  }

  const configContent = readConfig(resolved.configPath);
  const baseCatalog = loadTemplateCatalog(resolved.codexHome, configContent, resolved.catalogPath);
  const template = findNativeTemplate(baseCatalog);
  if (!baseCatalog || !template) {
    throw new Error(`Could not find a native Codex model catalog template. Run Codex once so ${resolved.cachePath} exists, or install a Codex CLI that supports "codex debug models --bundled".`);
  }

  const entries = resolved.options.models.map(model => deriveCustomEntry(
    template,
    resolved.options.providerId,
    resolved.options.providerName,
    model,
  ));
  const existingProvider = resolved.state.providers[resolved.options.providerId];
  const mergedCatalog = mergeCustomEntries(baseCatalog, existingProvider?.ownedSlugs ?? [], entries);
  const newConfig = applyRegisterConfig(configContent, resolved.options, resolved.catalogPath);

  const filePaths = [resolved.configPath, resolved.catalogPath, resolved.cachePath, resolved.paths.statePath, ...(resolved.profilePath ? [resolved.profilePath] : [])];
  const transactionId = resolved.options.backup === false ? undefined : createTransaction(resolved.paths, "register", filePaths);
  atomicWriteFile(resolved.configPath, newConfig);
  writeCatalog(resolved.catalogPath, mergedCatalog);
  if (resolved.profilePath) atomicWriteFile(resolved.profilePath, buildProfileFile(resolved.options, resolved.catalogPath));
  let nextState = updateProviderState(resolved.state, resolved.options, resolved.catalogPath, resolved.profilePath, plan.routedSlugs);
  if (transactionId) nextState = { ...nextState, lastTransactionId: transactionId };
  saveState(resolved.paths, nextState);
  invalidateModelsCache(resolved.codexHome, resolved.catalogPath);
  if (transactionId) markTransactionAfter(resolved.paths, transactionId);

  return {
    applied: true,
    transactionId,
    plan,
    added: plan.routedSlugs,
    catalogPath: resolved.catalogPath,
    configPath: resolved.configPath,
    cachePath: resolved.cachePath,
  };
}

export async function listModels(options: { codexHome?: string; stateDir?: string; providerId?: string } = {}): Promise<ListResult> {
  const codexHome = resolveCodexHomeDir(options.codexHome);
  const paths = modulePaths(codexHome, options.stateDir);
  const state = loadState(paths);
  const providers = Object.entries(state.providers)
    .filter(([providerId]) => !options.providerId || providerId === options.providerId)
    .map(([providerId, provider]) => ({ providerId, ...provider }));
  return { codexHome, statePath: paths.statePath, providers };
}

function requestedRemoveSlugs(providerId: string, ownedSlugs: string[], slugs?: string[]): string[] {
  if (!slugs || slugs.length === 0) return [...ownedSlugs];
  const owned = new Set(ownedSlugs);
  return slugs
    .map(slug => slug.startsWith(`${providerId}/`) ? slug : routedSlug(providerId, slug))
    .filter(slug => owned.has(slug));
}

function removeConfigForProvider(content: string, codexHome: string, providerId: string, catalogPath: string, hasAnyProvidersLeft: boolean): string {
  let out = stripProviderSection(content, providerId, false);
  out = removeRootModelProviderIf(out, providerId);
  if (!hasAnyProvidersLeft) {
    out = removeRootModelCatalogIf(out, path => samePath(resolveFromCodexHome(codexHome, path), catalogPath)
      || samePath(resolveFromCodexHome(codexHome, path), defaultCatalogPath(codexHome)));
  }
  return out;
}

export async function removeModels(options: {
  codexHome?: string;
  stateDir?: string;
  providerId: string;
  slugs?: string[];
  dryRun?: boolean;
  backup?: boolean;
}): Promise<RemoveResult> {
  validateProviderId(options.providerId);
  const codexHome = resolveCodexHomeDir(options.codexHome);
  const paths = modulePaths(codexHome, options.stateDir);
  const state = loadState(paths);
  const configPath = join(codexHome, CONFIG_FILENAME);
  const provider = state.providers[options.providerId];
  if (!provider) {
    return { applied: false, providerId: options.providerId, removed: [], remaining: [], configPath };
  }
  const targetSlugs = requestedRemoveSlugs(options.providerId, provider.ownedSlugs, options.slugs);
  if (targetSlugs.length === 0) {
    return { applied: false, providerId: options.providerId, removed: [], remaining: provider.ownedSlugs, catalogPath: provider.catalogPath, configPath };
  }
  if (options.dryRun) {
    return {
      applied: false,
      providerId: options.providerId,
      removed: targetSlugs,
      remaining: provider.ownedSlugs.filter(slug => !targetSlugs.includes(slug)),
      catalogPath: provider.catalogPath,
      configPath,
    };
  }

  const removedSet = new Set(targetSlugs);
  const remaining = provider.ownedSlugs.filter(slug => !removedSet.has(slug));
  const cachePath = modelsCachePath(codexHome);
  const filePaths = [
    configPath,
    provider.catalogPath,
    cachePath,
    paths.statePath,
    ...(remaining.length === 0 && provider.profilePath ? [provider.profilePath] : []),
  ];
  const transactionId = options.backup === false ? undefined : createTransaction(paths, "remove", filePaths);
  const catalog = readCatalog(provider.catalogPath);
  let removed: string[] = [];
  if (catalog) {
    const result = removeCatalogSlugs(catalog, targetSlugs);
    removed = result.removed;
    writeCatalog(provider.catalogPath, result.catalog);
  } else {
    removed = targetSlugs;
  }

  const nextState = { ...state, providers: { ...state.providers } };
  if (remaining.length === 0) {
    delete nextState.providers[options.providerId];
  } else {
    nextState.providers[options.providerId] = {
      ...provider,
      ownedSlugs: remaining,
      models: provider.models.filter(model => !removedSet.has(routedSlug(options.providerId, model.slug))),
      updatedAt: new Date().toISOString(),
    };
  }
  if (transactionId) nextState.lastTransactionId = transactionId;

  if (existsSync(configPath)) {
    const config = readFileSync(configPath, "utf8");
    const hasAnyProvidersLeft = Object.keys(nextState.providers).length > 0;
    atomicWriteFile(configPath, removeConfigForProvider(config, codexHome, options.providerId, provider.catalogPath, hasAnyProvidersLeft));
  }
  if (remaining.length === 0 && provider.profilePath) rmSync(provider.profilePath, { force: true });
  if (existsSync(provider.catalogPath)) invalidateModelsCache(codexHome, provider.catalogPath);
  removeStateIfEmpty(paths, nextState);
  if (transactionId) markTransactionAfter(paths, transactionId);

  return {
    applied: true,
    transactionId,
    providerId: options.providerId,
    removed,
    remaining,
    catalogPath: provider.catalogPath,
    configPath,
  };
}

export async function rollback(options: { codexHome?: string; stateDir?: string; transactionId?: string } = {}): Promise<RollbackResult> {
  const codexHome = resolveCodexHomeDir(options.codexHome);
  const paths = modulePaths(codexHome, options.stateDir);
  return rollbackFromJournal(paths, options.transactionId);
}

export async function doctor(options: { codexHome?: string; stateDir?: string } = {}): Promise<DoctorResult> {
  try {
    const codexHome = resolveCodexHomeDir(options.codexHome);
    const paths = modulePaths(codexHome, options.stateDir);
    const configPath = join(codexHome, CONFIG_FILENAME);
    const state = loadState(paths);
    const checks: DoctorResult["checks"] = [];
    if (existsSync(configPath)) checks.push({ name: "config", status: "pass", message: `Found ${configPath}` });
    else checks.push({ name: "config", status: "fail", message: `Missing ${configPath}` });

    const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const rootCatalog = config ? rootModelCatalogPath(config) : null;
    if (rootCatalog) {
      const catalogPath = resolveFromCodexHome(codexHome, rootCatalog);
      checks.push(existsSync(catalogPath)
        ? { name: "catalog", status: "pass", message: `Root model_catalog_json points to ${catalogPath}` }
        : { name: "catalog", status: "fail", message: `Root model_catalog_json points to missing ${catalogPath}` });
    } else {
      checks.push({ name: "catalog", status: "warn", message: "No root model_catalog_json is set" });
    }

    const providerEntries = Object.entries(state.providers);
    if (providerEntries.length === 0) {
      checks.push({ name: "state", status: "warn", message: "No codex-custom-models providers are registered" });
    } else {
      checks.push({ name: "state", status: "pass", message: `Tracked ${providerEntries.length} provider(s)` });
      for (const [providerId, provider] of providerEntries) {
        const catalog = readCatalog(provider.catalogPath);
        const catalogSlugs = new Set(catalog?.models.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []) ?? []);
        const missing = provider.ownedSlugs.filter(slug => !catalogSlugs.has(slug));
        checks.push(missing.length === 0
          ? { name: `provider:${providerId}`, status: "pass", message: `${provider.ownedSlugs.length} owned model(s) present in ${provider.catalogPath}` }
          : { name: `provider:${providerId}`, status: "fail", message: `Missing owned catalog slugs: ${missing.join(", ")}` });
      }
    }

    const cache = readCacheJson(modelsCachePath(codexHome));
    if (cache && cache.fetched_at === "2000-01-01T00:00:00Z") {
      checks.push({ name: "models-cache", status: "pass", message: "models_cache.json is an expired wrapper" });
    } else if (existsSync(modelsCachePath(codexHome))) {
      checks.push({ name: "models-cache", status: "warn", message: "models_cache.json exists but is not the codex-custom-models expired wrapper" });
    } else {
      checks.push({ name: "models-cache", status: "warn", message: "models_cache.json is missing" });
    }

    return {
      ok: checks.every(check => check.status !== "fail"),
      codexHome,
      stateDir: paths.stateDir,
      checks,
    };
  } catch (error) {
    return {
      ok: false,
      codexHome: options.codexHome ?? "",
      stateDir: options.stateDir ?? "",
      checks: [{ name: "codex-home", status: "fail", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function readCacheJson(path: string): { fetched_at?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { fetched_at?: unknown };
  } catch {
    return null;
  }
}

export type {
  CustomModelSpec,
  DoctorResult,
  ListResult,
  Plan,
  RegisterOptions,
  RegisterResult,
  RemoveResult,
  RollbackResult,
};
