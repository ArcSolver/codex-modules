import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appServerRequest,
  backupFile,
  findCodexBinary,
  getCodexVersion,
  listFeatures,
  readJson,
  resolveCodexHome,
  spliceManagedBlock,
  validateToml,
  writeFileAtomic,
  writeJsonAtomic,
  type CodexFeature,
  type CodexVersion,
} from "./kit/index.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type CommandHook = {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
};

export type HookGroup = {
  matcher?: string;
  hooks: CommandHook[];
};

export type HookSet = {
  [event in HookEvent]?: HookGroup[];
};

export type CommonOptions = {
  codexHome?: string;
  bin?: string | null;
  cwds?: string[];
};

export type PlanOptions = CommonOptions;
export type ApplyOptions = CommonOptions;
export type TrustOptions = CommonOptions & {
  cwds?: string[];
};
export type RemoveOptions = CommonOptions & {
  deleteCreatedFile?: boolean;
};

export type HookIdentity = {
  event: HookEvent;
  matcher?: string;
  command: string;
};

export type Manifest = {
  version: 1;
  hooksJsonCreated: boolean;
  entries: HookIdentity[];
};

export type PlanChange = {
  event: HookEvent;
  matcher?: string;
  command: string;
  action: "add" | "already-present" | "replace";
};

export type PlanResult = {
  codexHome: string;
  hooksPath: string;
  manifestPath: string;
  changes: PlanChange[];
  summary: {
    add: number;
    alreadyPresent: number;
    replace: number;
  };
};

export type ApplyResult = PlanResult & {
  applied: true;
  backup: string | null;
  manifest: Manifest;
};

export type TrustResult = {
  codexHome: string;
  configPath: string;
  backup: string | null;
  trusted: TrustedHookState[];
  missing: HookIdentity[];
};

export type RemoveResult = {
  codexHome: string;
  hooksPath: string;
  configPath: string;
  hooksBackup: string | null;
  configBackup: string | null;
  removed: HookIdentity[];
  remainingManagedEntries: number;
  deletedHooksJson: boolean;
};

export type StatusResult = {
  codexHome: string;
  codexBinary: string | null;
  version: CodexVersion | null;
  features: CodexFeature[];
  hooks: DiscoveredHook[];
  discoveryWarnings: string[];
  appServerError: string | null;
  versionGate: VersionGate;
};

export type DoctorResult = StatusResult & {
  ok: boolean;
  warnings: string[];
};

export type BuildExecArgsOptions = {
  bypassTrust?: boolean;
};

export type VersionGate = {
  sessionFlags: "ok" | "warn" | "unknown";
  message: string;
};

type HooksFile = {
  description?: string;
  hooks?: HookSet;
  [key: string]: unknown;
};

type DiscoveredHook = {
  key?: string;
  currentHash?: string;
  trustStatus?: string;
  enabled?: boolean;
  event?: string;
  matcher?: string | null;
  command?: string;
  [key: string]: unknown;
};

type TrustedHookState = HookIdentity & {
  key: string;
  currentHash: string;
};

const MANIFEST_NAME = ".codex-hooks-manifest.json";
const HOOKS_NAME = "hooks.json";
const CONFIG_NAME = "config.toml";
const TRUST_OWNER = "codex-hooks";
const TRUST_BLOCK_ID = "hooks-state";

const EVENT_SET = new Set<string>(HOOK_EVENTS);

export function validateHookSet(value: unknown): HookSet {
  if (!isPlainObject(value)) throw new Error("HookSet must be an object");
  const result: HookSet = {};
  for (const [event, groups] of Object.entries(value)) {
    if (!EVENT_SET.has(event)) throw new Error(`Unsupported hook event: ${event}`);
    if (!Array.isArray(groups)) throw new Error(`HookSet.${event} must be an array`);
    result[event as HookEvent] = groups.map((group, groupIndex) => validateGroup(event, group, groupIndex));
  }
  return result;
}

export function plan(hookSet: HookSet, opts: PlanOptions = {}): PlanResult {
  const context = paths(opts.codexHome);
  const wanted = validateHookSet(hookSet);
  const existing = readHooksFile(context.hooksPath);
  const existingHooks = validateHookSet(existing.hooks ?? {});
  const manifest = readManifest(context.manifestPath);
  const changes: PlanChange[] = [];

  for (const identity of identitiesFromHookSet(wanted)) {
    const eventGroups = existingHooks[identity.event] ?? [];
    const sameGroup = eventGroups.find(group => normalizedMatcher(group.matcher) === normalizedMatcher(identity.matcher));
    const sameCommand = sameGroup?.hooks.some(hook => hook.command === identity.command) ?? false;
    const replacesOwned = (manifest?.entries ?? []).some(entry =>
      entry.event === identity.event &&
      normalizedMatcher(entry.matcher) === normalizedMatcher(identity.matcher) &&
      entry.command !== identity.command);
    changes.push({
      ...identity,
      action: sameCommand ? "already-present" : replacesOwned ? "replace" : "add",
    });
  }

  return {
    codexHome: context.codexHome,
    hooksPath: context.hooksPath,
    manifestPath: context.manifestPath,
    changes,
    summary: {
      add: changes.filter(change => change.action === "add").length,
      alreadyPresent: changes.filter(change => change.action === "already-present").length,
      replace: changes.filter(change => change.action === "replace").length,
    },
  };
}

export function apply(hookSet: HookSet, opts: ApplyOptions = {}): ApplyResult {
  const context = paths(opts.codexHome);
  const wanted = validateHookSet(hookSet);
  const planned = plan(wanted, opts);
  const hooksJsonCreated = !existsSync(context.hooksPath);
  const existing = readHooksFile(context.hooksPath);
  const existingHooks = validateHookSet(existing.hooks ?? {});
  const previousManifest = readManifest(context.manifestPath);
  const wantedIdentities = identitiesFromHookSet(wanted);
  const replacementRemovals = (previousManifest?.entries ?? []).filter(entry =>
    wantedIdentities.some(wantedEntry =>
      wantedEntry.event === entry.event &&
      normalizedMatcher(wantedEntry.matcher) === normalizedMatcher(entry.matcher) &&
      wantedEntry.command !== entry.command));
  const baseHooks = replacementRemovals.length > 0 ? removeIdentities(existingHooks, replacementRemovals) : existingHooks;
  const merged = mergeHookSets(baseHooks, wanted);
  const backup = backupFile(context.hooksPath);
  const next: HooksFile = {
    ...existing,
    hooks: pruneEmptyEvents(merged),
  };
  writeJsonAtomic(context.hooksPath, next);

  const manifest: Manifest = {
    version: 1,
    hooksJsonCreated: previousManifest?.hooksJsonCreated ?? hooksJsonCreated,
    entries: uniqueIdentities([
      ...(previousManifest?.entries ?? []).filter(entry => !replacementRemovals.some(removal => identityKey(removal) === identityKey(entry))),
      ...wantedIdentities,
    ]),
  };
  writeJsonAtomic(context.manifestPath, manifest);

  return {
    ...planned,
    applied: true,
    backup,
    manifest,
  };
}

export async function trust(opts: TrustOptions = {}): Promise<TrustResult> {
  const context = paths(opts.codexHome);
  const manifest = readManifest(context.manifestPath);
  if (!manifest) throw new Error(`codex-hooks manifest not found: ${context.manifestPath}`);

  const discovered = await listHooks({ ...opts, codexHome: context.codexHome });
  const trusted: TrustedHookState[] = [];
  const missing: HookIdentity[] = [];
  for (const entry of manifest.entries) {
    const match = findDiscoveredHook(discovered, entry);
    if (match?.key && match.currentHash) {
      trusted.push({ ...entry, key: match.key, currentHash: match.currentHash });
    } else {
      missing.push(entry);
    }
  }

  const prior = existsSync(context.configPath) ? readFileSync(context.configPath, "utf8") : "";
  const backup = backupFile(context.configPath);
  const body = trusted
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(item => `[hooks.state.${tomlQuote(item.key)}]\ntrusted_hash = ${tomlQuote(item.currentHash)}\nenabled = true`)
    .join("\n\n");
  const next = spliceManagedBlock(prior, TRUST_OWNER, TRUST_BLOCK_ID, body);
  const validation = validateToml(next);
  if (!validation.ok) throw new Error(`generated config.toml is invalid: ${validation.error}`);
  writeFileAtomic(context.configPath, next);

  return {
    codexHome: context.codexHome,
    configPath: context.configPath,
    backup,
    trusted,
    missing,
  };
}

export function remove(opts: RemoveOptions = {}): RemoveResult {
  const context = paths(opts.codexHome);
  const manifest = readManifest(context.manifestPath);
  const entries = manifest?.entries ?? [];
  const existing = readHooksFile(context.hooksPath);
  const existingHooks = validateHookSet(existing.hooks ?? {});
  const nextHooks = removeIdentities(existingHooks, entries);
  const hooksBackup = existsSync(context.hooksPath) ? backupFile(context.hooksPath) : null;
  let deletedHooksJson = false;

  if (manifest?.hooksJsonCreated && opts.deleteCreatedFile && Object.keys(pruneEmptyEvents(nextHooks)).length === 0) {
    rmSync(context.hooksPath, { force: true });
    deletedHooksJson = true;
  } else if (existsSync(context.hooksPath)) {
    writeJsonAtomic(context.hooksPath, { ...existing, hooks: pruneEmptyEvents(nextHooks) });
  }

  const priorConfig = existsSync(context.configPath) ? readFileSync(context.configPath, "utf8") : "";
  const configBackup = existsSync(context.configPath) ? backupFile(context.configPath) : null;
  const nextConfig = spliceManagedBlock(priorConfig, TRUST_OWNER, TRUST_BLOCK_ID, null);
  if (nextConfig.length > 0 || existsSync(context.configPath)) {
    const validation = validateToml(nextConfig);
    if (!validation.ok) throw new Error(`generated config.toml is invalid: ${validation.error}`);
    writeFileAtomic(context.configPath, nextConfig);
  }
  rmSync(context.manifestPath, { force: true });

  return {
    codexHome: context.codexHome,
    hooksPath: context.hooksPath,
    configPath: context.configPath,
    hooksBackup,
    configBackup,
    removed: entries,
    remainingManagedEntries: 0,
    deletedHooksJson,
  };
}

export async function status(opts: CommonOptions = {}): Promise<StatusResult> {
  const codexBinary = opts.bin === undefined ? findCodexBinary() : opts.bin;
  const version = getCodexVersion(codexBinary);
  const features = codexBinary ? safeFeatures(codexBinary) : [];
  let hooks: DiscoveredHook[] = [];
  let discoveryWarnings: string[] = [];
  let appServerError: string | null = null;
  try {
    const detailed = await listHooksDetailed(opts);
    hooks = detailed.hooks;
    discoveryWarnings = detailed.warnings;
  } catch (error) {
    appServerError = error instanceof Error ? error.message : String(error);
  }

  return {
    codexHome: paths(opts.codexHome).codexHome,
    codexBinary,
    version,
    features,
    hooks,
    discoveryWarnings,
    appServerError,
    versionGate: versionGate(version),
  };
}

export async function doctor(opts: CommonOptions = {}): Promise<DoctorResult> {
  const result = await status(opts);
  const warnings: string[] = [];
  const hooksFeature = result.features.find(feature => feature.name === "hooks");
  if (!result.codexBinary) warnings.push("codex binary not found");
  if (result.appServerError) warnings.push(`hooks/list unavailable: ${result.appServerError}`);
  if (!hooksFeature) warnings.push("feature hooks not reported by codex features list");
  else if (!hooksFeature.enabled) warnings.push("feature hooks is disabled");
  if (result.versionGate.sessionFlags === "warn") warnings.push(result.versionGate.message);
  if (result.versionGate.sessionFlags === "unknown") warnings.push(result.versionGate.message);
  for (const warning of result.discoveryWarnings) {
    warnings.push(`hooks discovery: ${warning}`);
  }
  return {
    ...result,
    ok: warnings.length === 0,
    warnings,
  };
}

export function buildExecArgs(hookSet: HookSet, opts: BuildExecArgsOptions = {}): string[] {
  const wanted = validateHookSet(hookSet);
  const args: string[] = [];
  if (opts.bypassTrust ?? true) args.push("--dangerously-bypass-hook-trust");
  for (const event of HOOK_EVENTS) {
    const groups = wanted[event];
    if (!groups || groups.length === 0) continue;
    args.push("-c", `hooks.${event}=${tomlInlineArray(groups)}`);
  }
  return args;
}

async function listHooks(opts: TrustOptions = {}): Promise<DiscoveredHook[]> {
  return (await listHooksDetailed(opts)).hooks;
}

async function listHooksDetailed(
  opts: TrustOptions = {},
): Promise<{ hooks: DiscoveredHook[]; warnings: string[] }> {
  const result = await appServerRequest<unknown>("hooks/list", { cwds: opts.cwds ?? [] }, {
    codexHome: opts.codexHome,
    bin: opts.bin,
    timeoutMs: 7000,
  });
  if (Array.isArray(result)) return { hooks: result as DiscoveredHook[], warnings: [] };
  if (isPlainObject(result)) {
    for (const key of ["hooks", "items", "entries"]) {
      const value = result[key];
      if (Array.isArray(value)) return { hooks: value as DiscoveredHook[], warnings: [] };
    }
    if (Array.isArray(result.data)) {
      const hooks: DiscoveredHook[] = [];
      const warnings: string[] = [];
      for (const item of result.data) {
        if (!isPlainObject(item)) continue;
        if (Array.isArray(item.hooks)) hooks.push(...(item.hooks as DiscoveredHook[]));
        if (Array.isArray(item.warnings)) {
          for (const warning of item.warnings) {
            if (typeof warning === "string") warnings.push(warning);
          }
        }
      }
      return { hooks, warnings };
    }
  }
  return { hooks: [], warnings: [] };
}

function paths(codexHome?: string): { codexHome: string; hooksPath: string; configPath: string; manifestPath: string } {
  const resolved = codexHome ?? resolveCodexHome();
  return {
    codexHome: resolved,
    hooksPath: join(resolved, HOOKS_NAME),
    configPath: join(resolved, CONFIG_NAME),
    manifestPath: join(resolved, MANIFEST_NAME),
  };
}

function readHooksFile(hooksPath: string): HooksFile {
  if (!existsSync(hooksPath)) return { hooks: {} };
  const parsed = readJson<unknown>(hooksPath);
  if (!isPlainObject(parsed)) throw new Error(`hooks.json must be an object: ${hooksPath}`);
  return parsed as HooksFile;
}

function readManifest(manifestPath: string): Manifest | null {
  if (!existsSync(manifestPath)) return null;
  const parsed = readJson<unknown>(manifestPath);
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`invalid codex-hooks manifest: ${manifestPath}`);
  }
  return parsed as Manifest;
}

function validateGroup(event: string, value: unknown, groupIndex: number): HookGroup {
  if (!isPlainObject(value)) throw new Error(`HookSet.${event}[${groupIndex}] must be an object`);
  const matcher = value.matcher;
  if (matcher !== undefined && typeof matcher !== "string") {
    throw new Error(`HookSet.${event}[${groupIndex}].matcher must be a string`);
  }
  if (!Array.isArray(value.hooks)) throw new Error(`HookSet.${event}[${groupIndex}].hooks must be an array`);
  const hooks = value.hooks.map((hook, hookIndex) => validateCommandHook(event, groupIndex, hook, hookIndex));
  return matcher === undefined ? { hooks } : { matcher, hooks };
}

function validateCommandHook(event: string, groupIndex: number, value: unknown, hookIndex: number): CommandHook {
  if (!isPlainObject(value)) throw new Error(`HookSet.${event}[${groupIndex}].hooks[${hookIndex}] must be an object`);
  if (value.type !== "command") throw new Error(`HookSet.${event}[${groupIndex}].hooks[${hookIndex}].type must be "command"`);
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new Error(`HookSet.${event}[${groupIndex}].hooks[${hookIndex}].command must be a non-empty string`);
  }
  const result: CommandHook = { type: "command", command: value.command };
  const timeout = value.timeout;
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(`HookSet.${event}[${groupIndex}].hooks[${hookIndex}].timeout must be a positive integer`);
    }
    result.timeout = timeout;
  }
  if (value.statusMessage !== undefined) {
    if (typeof value.statusMessage !== "string") {
      throw new Error(`HookSet.${event}[${groupIndex}].hooks[${hookIndex}].statusMessage must be a string`);
    }
    result.statusMessage = value.statusMessage;
  }
  return result;
}

function mergeHookSets(existing: HookSet, wanted: HookSet): HookSet {
  const merged: HookSet = cloneHookSet(existing);
  for (const event of HOOK_EVENTS) {
    const wantedGroups = wanted[event] ?? [];
    if (wantedGroups.length === 0) continue;
    const groups = merged[event] ? [...merged[event]!] : [];
    for (const wantedGroup of wantedGroups) {
      let target = groups.find(group => normalizedMatcher(group.matcher) === normalizedMatcher(wantedGroup.matcher));
      if (!target) {
        target = wantedGroup.matcher === undefined ? { hooks: [] } : { matcher: wantedGroup.matcher, hooks: [] };
        groups.push(target);
      }
      for (const hook of wantedGroup.hooks) {
        if (!target.hooks.some(existingHook => sameCommandHook(existingHook, hook))) {
          target.hooks.push({ ...hook });
        }
      }
    }
    merged[event] = groups;
  }
  return merged;
}

function removeIdentities(existing: HookSet, entries: HookIdentity[]): HookSet {
  const byEvent = new Map<HookEvent, HookIdentity[]>();
  for (const entry of entries) {
    const list = byEvent.get(entry.event) ?? [];
    list.push(entry);
    byEvent.set(entry.event, list);
  }
  const next: HookSet = {};
  for (const event of HOOK_EVENTS) {
    const groups = existing[event] ?? [];
    const removals = byEvent.get(event) ?? [];
    const keptGroups: HookGroup[] = [];
    for (const group of groups) {
      const keptHooks = group.hooks.filter(hook => !removals.some(entry =>
        normalizedMatcher(entry.matcher) === normalizedMatcher(group.matcher) && entry.command === hook.command));
      if (keptHooks.length > 0) keptGroups.push(group.matcher === undefined ? { hooks: keptHooks } : { matcher: group.matcher, hooks: keptHooks });
    }
    if (keptGroups.length > 0) next[event] = keptGroups;
  }
  return next;
}

function identitiesFromHookSet(hookSet: HookSet): HookIdentity[] {
  const identities: HookIdentity[] = [];
  for (const event of HOOK_EVENTS) {
    for (const group of hookSet[event] ?? []) {
      for (const hook of group.hooks) {
        identities.push(group.matcher === undefined ? { event, command: hook.command } : { event, matcher: group.matcher, command: hook.command });
      }
    }
  }
  return uniqueIdentities(identities);
}

function uniqueIdentities(entries: HookIdentity[]): HookIdentity[] {
  const seen = new Set<string>();
  const unique: HookIdentity[] = [];
  for (const entry of entries) {
    const key = identityKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...entry });
  }
  return unique;
}

function findDiscoveredHook(hooks: DiscoveredHook[], identity: HookIdentity): DiscoveredHook | null {
  return hooks.find(hook => {
    const event = normalizeEventName(hook.eventName ?? hook.event) ?? eventFromKey(hook.key);
    const command = hook.command ?? commandFromUnknown(hook);
    const matcher = hook.matcher === null ? undefined : hook.matcher;
    return event === identity.event &&
      command === identity.command &&
      (matcher === undefined || normalizedMatcher(matcher) === normalizedMatcher(identity.matcher));
  }) ?? hooks.find(hook => {
    const key = hook.key ?? "";
    const command = hook.command ?? commandFromUnknown(hook);
    return key.includes(eventToSnake(identity.event)) && command === identity.command;
  }) ?? null;
}

function eventFromKey(key: string | undefined): HookEvent | undefined {
  if (!key) return undefined;
  for (const event of HOOK_EVENTS) {
    if (key.includes(eventToSnake(event))) return event;
  }
  return undefined;
}

function normalizeEventName(value: unknown): HookEvent | undefined {
  if (typeof value !== "string") return undefined;
  if (EVENT_SET.has(value)) return value as HookEvent;
  const compact = value.replace(/[_-]/g, "").toLowerCase();
  return HOOK_EVENTS.find(event => event.toLowerCase() === compact);
}

function commandFromUnknown(value: Record<string, unknown>): string | undefined {
  for (const key of ["command", "cmd"]) {
    if (typeof value[key] === "string") return value[key];
  }
  const hook = value.hook;
  if (isPlainObject(hook) && typeof hook.command === "string") return hook.command;
  const handler = value.handler;
  if (isPlainObject(handler) && typeof handler.command === "string") return handler.command;
  return undefined;
}

function versionGate(version: CodexVersion | null): VersionGate {
  if (!version) {
    return {
      sessionFlags: "unknown",
      message: "cannot verify session-flags backend without a codex version",
    };
  }
  if (compareVersion(version.version, [0, 142, 0]) >= 0) {
    return {
      sessionFlags: "ok",
      message: "session-flags backend ok (measured firing on 0.142.5+)",
    };
  }
  return {
    sessionFlags: "warn",
    message: "exec-path firing unverified/broken (measured: 0.139 no-fire)",
  };
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const delta = left[i]! - right[i]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function safeFeatures(bin: string): CodexFeature[] {
  try {
    return listFeatures({ bin });
  } catch {
    return [];
  }
}

function cloneHookSet(value: HookSet): HookSet {
  const clone: HookSet = {};
  for (const event of HOOK_EVENTS) {
    if (value[event]) {
      clone[event] = value[event]!.map(group => ({
        ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
        hooks: group.hooks.map(hook => ({ ...hook })),
      }));
    }
  }
  return clone;
}

function pruneEmptyEvents(value: HookSet): HookSet {
  const result: HookSet = {};
  for (const event of HOOK_EVENTS) {
    const groups = value[event]?.filter(group => group.hooks.length > 0) ?? [];
    if (groups.length > 0) result[event] = groups;
  }
  return result;
}

function normalizedMatcher(value: string | undefined): string {
  return value ?? "";
}

function sameCommandHook(left: CommandHook, right: CommandHook): boolean {
  return left.type === right.type && left.command === right.command;
}

function identityKey(entry: HookIdentity): string {
  return `${entry.event}\0${normalizedMatcher(entry.matcher)}\0${entry.command}`;
}

function eventToSnake(event: HookEvent): string {
  return event.replace(/[A-Z]/g, (char, index) => `${index === 0 ? "" : "_"}${char.toLowerCase()}`);
}

function tomlInlineArray(groups: HookGroup[]): string {
  return `[${groups.map(tomlInlineGroup).join(",")}]`;
}

function tomlInlineGroup(group: HookGroup): string {
  const parts: string[] = [];
  if (group.matcher !== undefined) parts.push(`matcher=${tomlQuote(group.matcher)}`);
  parts.push(`hooks=[${group.hooks.map(tomlInlineHook).join(",")}]`);
  return `{${parts.join(",")}}`;
}

function tomlInlineHook(hook: CommandHook): string {
  const parts = [`type="command"`, `command=${tomlQuote(hook.command)}`];
  if (hook.timeout !== undefined) parts.push(`timeout=${hook.timeout}`);
  if (hook.statusMessage !== undefined) parts.push(`statusMessage=${tomlQuote(hook.statusMessage)}`);
  return `{${parts.join(",")}}`;
}

function tomlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\u0008/g, "\\b")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f")
    .replace(/\r/g, "\\r")}"`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ensureDirFor(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
