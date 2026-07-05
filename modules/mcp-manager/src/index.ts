import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  appendChange,
  backupFile,
  findCodexBinary,
  getCodexVersion,
  insertUnderTomlTable,
  readChanges,
  resolveCodexHome,
  validateToml,
  writeFileAtomic,
  type ChangeRecord,
} from "./kit/index.js";

export type StdioServerDef = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  envVars?: string[];
};

export type HttpServerDef = {
  name: string;
  url: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
};

export type ServerDef = StdioServerDef | HttpServerDef;

export type ManagerOptions = {
  codexHome?: string;
  bin?: string | null;
  timeoutMs?: number;
  stateDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export type AddOptions = ManagerOptions & {
  force?: boolean;
};

export type PatchValue = string | number | boolean | string[] | number[] | boolean[] | Record<string, string>;
export type PatchKeys = Record<string, PatchValue>;

export type PlanResult = {
  ok: boolean;
  action: "add";
  serverName: string;
  codexHome: string;
  configPath: string;
  status: "new" | "conflict";
  changes: string[];
  conflicts: string[];
  existing?: unknown;
};

export type MutationResult = {
  serverName: string;
  codexHome: string;
  configPath: string;
  backup: string | null;
  manifestPath: string;
  server?: unknown;
};

export type RollbackResult = {
  ok: boolean;
  missing: boolean;
  codexHome: string;
  configPath?: string;
  backup?: string;
  manifestPath: string;
};

export type DoctorResult = {
  ok: boolean;
  codexHome: string;
  configPath: string;
  codexBinary: string | null;
  version: string | null;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
  servers: Array<{ name: string; authStatus?: unknown }>;
};

type Resolved = {
  codexHome: string;
  configPath: string;
  stateDir: string;
  backupDir: string;
  manifestPath: string;
  bin: string | null;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
};

const MODULE_NAME = "codex-mcp-manager";
const MANIFEST = "manifest.jsonl";
const ADVANCED_KEYS = new Set([
  "cwd",
  "default_tools_approval_mode",
  "disabled_tools",
  "enabled",
  "enabled_tools",
  "env_http_headers",
  "env_vars",
  "environment_id",
  "http_headers",
  "oauth_resource",
  "required",
  "scopes",
  "startup_timeout_ms",
  "startup_timeout_sec",
  "supports_parallel_tool_calls",
  "tool_timeout_sec",
]);

function isHttp(def: ServerDef): def is HttpServerDef {
  return "url" in def;
}

function resolve(opts: ManagerOptions = {}): Resolved {
  const baseEnv = { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
  if (opts.codexHome) baseEnv.CODEX_HOME = opts.codexHome;
  const codexHome = resolveCodexHome(baseEnv);
  const stateDir = opts.stateDir ?? join(codexHome, `${MODULE_NAME}-state`);
  return {
    codexHome,
    configPath: join(codexHome, "config.toml"),
    stateDir,
    backupDir: join(stateDir, "backups"),
    manifestPath: join(stateDir, MANIFEST),
    bin: opts.bin === undefined ? findCodexBinary(baseEnv) : opts.bin,
    timeoutMs: opts.timeoutMs ?? 15000,
    env: { ...baseEnv, CODEX_HOME: codexHome },
  };
}

function assertServerName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`MCP server name must use only letters, numbers, underscore, or hyphen: ${name}`);
  }
}

function assertNoPlaintextBearerToken(value: unknown, path = "server"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    if (normalized === "bearertoken") {
      throw new Error(`${path}.${key} is not allowed; use bearerTokenEnvVar instead`);
    }
    assertNoPlaintextBearerToken(child, `${path}.${key}`);
  }
}

function normalizeDef(def: ServerDef): ServerDef {
  assertNoPlaintextBearerToken(def);
  assertServerName(def.name);
  if (isHttp(def)) {
    if (!def.url || typeof def.url !== "string") throw new Error("HTTP MCP server requires url");
    if (def.bearerTokenEnvVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(def.bearerTokenEnvVar)) {
      throw new Error(`bearerTokenEnvVar must be an environment variable name: ${def.bearerTokenEnvVar}`);
    }
    return {
      name: def.name,
      url: def.url,
      bearerTokenEnvVar: def.bearerTokenEnvVar,
      httpHeaders: def.httpHeaders,
    };
  }
  if (!def.command || typeof def.command !== "string") throw new Error("stdio MCP server requires command");
  return {
    name: def.name,
    command: def.command,
    args: def.args ?? [],
    env: def.env,
    envVars: def.envVars,
  };
}

function requireCodex(resolved: Resolved): string {
  if (!resolved.bin) {
    throw new Error("codex binary not found in PATH. Install Codex CLI or pass a PATH that contains codex.");
  }
  return resolved.bin;
}

function runCodex(args: string[], opts: ManagerOptions = {}, allowFailure = false): { stdout: string; stderr: string; status: number | null } {
  const resolved = resolve(opts);
  const bin = requireCodex(resolved);
  const result = spawnSync(bin, args, {
    env: resolved.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: resolved.timeoutMs,
  });
  if ((result.error || result.status !== 0) && !allowFailure) {
    const reason = result.error ? result.error.message : `${result.stderr}${result.stdout}`.trim();
    throw new Error(`codex ${args.join(" ")} failed${reason ? `: ${reason}` : ""}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function parseJsonOutput<T>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command} returned invalid JSON: ${message}`);
  }
}

function readConfigServer(name: string, configPath: string): unknown | null {
  if (!existsSync(configPath)) return null;
  const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const servers = parsed.mcp_servers;
  if (!servers || typeof servers !== "object") return null;
  return (servers as Record<string, unknown>)[name] ?? null;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function renderTomlValue(value: PatchValue): string {
  if (typeof value === "string") return jsonString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`TOML number must be finite: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(item => renderTomlValue(item as PatchValue)).join(", ")}]`;
  const entries = Object.entries(value).map(([key, child]) => `${jsonString(key)} = ${jsonString(child)}`);
  return `{ ${entries.join(", ")} }`;
}

function renderPatchLines(keys: PatchKeys): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(keys)) {
    const normalized = key.trim();
    const bearerKey = normalized.replace(/[-_]/g, "").toLowerCase();
    if (bearerKey === "bearertoken") throw new Error(`${key} is not allowed; use bearer_token_env_var`);
    if (!ADVANCED_KEYS.has(normalized)) throw new Error(`unsupported MCP patch key: ${key}`);
    lines.push(`${normalized} = ${renderTomlValue(value)}`);
  }
  return lines;
}

function removeExistingKeysFromTable(content: string, tablePath: string, keys: string[]): string {
  const header = `[${tablePath}]`;
  const lines = content.split("\n");
  const start = lines.findIndex(line => line.trim() === header);
  if (start === -1) throw new Error(`TOML table not found: ${header}`);
  const keySet = new Set(keys);
  const out = [...lines];
  for (let index = start + 1; index < out.length; index++) {
    const line = out[index]!;
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match && keySet.has(match[1]!)) out[index] = "";
  }
  return out.filter((line, index) => line !== "" || lines[index] === "").join("\n");
}

function record(resolved: Resolved, action: string, backup: string | null, extra: Record<string, unknown> = {}): void {
  const change: ChangeRecord = {
    ts: new Date().toISOString(),
    action,
    file: resolved.configPath,
    backup,
    ...extra,
  };
  appendChange(resolved.manifestPath, change);
}

function createBackup(resolved: Resolved): string | null {
  mkdirSync(resolved.backupDir, { recursive: true });
  return backupFile(resolved.configPath, resolved.backupDir);
}

function buildAddArgs(def: ServerDef): string[] {
  if (isHttp(def)) {
    const args = ["mcp", "add", def.name, "--url", def.url];
    if (def.bearerTokenEnvVar) args.push("--bearer-token-env-var", def.bearerTokenEnvVar);
    return args;
  }
  const args = ["mcp", "add", def.name];
  for (const [key, value] of Object.entries(def.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push("--", def.command, ...(def.args ?? []));
  return args;
}

export async function listServers(opts: ManagerOptions = {}): Promise<unknown[]> {
  const result = runCodex(["mcp", "list", "--json"], opts);
  return parseJsonOutput<unknown[]>(result.stdout, "codex mcp list --json");
}

export async function getServer(name: string, opts: ManagerOptions = {}): Promise<unknown | null> {
  assertServerName(name);
  const result = runCodex(["mcp", "get", name, "--json"], opts, true);
  if (result.status !== 0) return null;
  return parseJsonOutput<unknown>(result.stdout, `codex mcp get ${name} --json`);
}

export async function plan(def: ServerDef, opts: ManagerOptions = {}): Promise<PlanResult> {
  const normalized = normalizeDef(def);
  const resolved = resolve(opts);
  let existing: unknown | null = null;
  if (resolved.bin) {
    existing = await getServer(normalized.name, opts);
  } else {
    existing = readConfigServer(normalized.name, resolved.configPath);
  }
  const changes = [`add [mcp_servers.${normalized.name}] via codex mcp add`];
  if (!isHttp(normalized) && normalized.envVars?.length) changes.push("patch env_vars under server table");
  if (isHttp(normalized) && normalized.httpHeaders && Object.keys(normalized.httpHeaders).length > 0) {
    changes.push("patch http_headers under server table");
  }
  const conflicts = existing ? [`MCP server "${normalized.name}" already exists. Re-run add with --force to replace it.`] : [];
  return {
    ok: conflicts.length === 0,
    action: "add",
    serverName: normalized.name,
    codexHome: resolved.codexHome,
    configPath: resolved.configPath,
    status: existing ? "conflict" : "new",
    changes,
    conflicts,
    existing: existing ?? undefined,
  };
}

export async function addServer(def: ServerDef, opts: AddOptions = {}): Promise<MutationResult> {
  const normalized = normalizeDef(def);
  const resolved = resolve(opts);
  requireCodex(resolved);
  const existing = await getServer(normalized.name, opts);
  if (existing && !opts.force) {
    throw new Error(`MCP server "${normalized.name}" already exists. Pass force: true or --force to replace it.`);
  }
  const backup = createBackup(resolved);
  record(resolved, "add-backup", backup, { serverName: normalized.name, force: opts.force === true });
  runCodex(buildAddArgs(normalized), opts);
  if (!isHttp(normalized) && normalized.envVars?.length) {
    await patchServer(normalized.name, { env_vars: normalized.envVars }, opts);
  }
  if (isHttp(normalized) && normalized.httpHeaders && Object.keys(normalized.httpHeaders).length > 0) {
    await patchServer(normalized.name, { http_headers: normalized.httpHeaders }, opts);
  }
  const server = await getServer(normalized.name, opts);
  if (!server) throw new Error(`codex mcp add did not create "${normalized.name}"`);
  return {
    serverName: normalized.name,
    codexHome: resolved.codexHome,
    configPath: resolved.configPath,
    backup,
    manifestPath: resolved.manifestPath,
    server,
  };
}

export function patchServerText(content: string, name: string, keys: PatchKeys): string {
  assertServerName(name);
  assertNoPlaintextBearerToken(keys, "keys");
  const parsedBefore = validateToml(content);
  if (!parsedBefore.ok) throw new Error(`config TOML is invalid before patch: ${parsedBefore.error}`);
  const lines = renderPatchLines(keys);
  const tablePath = `mcp_servers.${name}`;
  const withoutDuplicates = removeExistingKeysFromTable(content, tablePath, Object.keys(keys));
  return insertUnderTomlTable(withoutDuplicates, tablePath, lines);
}

export async function patchServer(name: string, keys: PatchKeys, opts: ManagerOptions = {}): Promise<MutationResult> {
  assertServerName(name);
  const resolved = resolve(opts);
  requireCodex(resolved);
  if (!existsSync(resolved.configPath)) throw new Error(`Codex config not found: ${resolved.configPath}`);
  const backup = createBackup(resolved);
  record(resolved, "patch-backup", backup, { serverName: name, keys: Object.keys(keys) });
  const next = patchServerText(readFileSync(resolved.configPath, "utf8"), name, keys);
  writeFileAtomic(resolved.configPath, next);
  const parsedAfter = validateToml(next);
  if (!parsedAfter.ok) throw new Error(`config TOML is invalid after patch: ${parsedAfter.error}`);
  const server = await getServer(name, opts);
  if (!server) throw new Error(`codex mcp get could not parse patched server "${name}"`);
  return {
    serverName: name,
    codexHome: resolved.codexHome,
    configPath: resolved.configPath,
    backup,
    manifestPath: resolved.manifestPath,
    server,
  };
}

export async function removeServer(name: string, opts: ManagerOptions = {}): Promise<MutationResult> {
  assertServerName(name);
  const resolved = resolve(opts);
  requireCodex(resolved);
  const backup = createBackup(resolved);
  record(resolved, "remove-backup", backup, { serverName: name });
  runCodex(["mcp", "remove", name], opts);
  return {
    serverName: name,
    codexHome: resolved.codexHome,
    configPath: resolved.configPath,
    backup,
    manifestPath: resolved.manifestPath,
  };
}

export async function rollback(opts: ManagerOptions = {}): Promise<RollbackResult> {
  const resolved = resolve(opts);
  const changes = readChanges(resolved.manifestPath)
    .filter(change => typeof change.backup === "string" && typeof change.file === "string")
    .reverse();
  const last = changes[0];
  if (!last || !last.backup || !existsSync(last.backup)) {
    return { ok: false, missing: true, codexHome: resolved.codexHome, manifestPath: resolved.manifestPath };
  }
  writeFileAtomic(last.file, readFileSync(last.backup));
  record(resolved, "rollback", null, { restoredFrom: last.backup, restoredFile: last.file });
  return {
    ok: true,
    missing: false,
    codexHome: resolved.codexHome,
    configPath: last.file,
    backup: last.backup,
    manifestPath: resolved.manifestPath,
  };
}

export async function doctor(opts: ManagerOptions = {}): Promise<DoctorResult> {
  const resolved = resolve(opts);
  const checks: DoctorResult["checks"] = [];
  const version = getCodexVersion(resolved.bin);
  if (resolved.bin) checks.push({ name: "codex-binary", status: "pass", message: resolved.bin });
  else checks.push({ name: "codex-binary", status: "fail", message: "codex binary not found in PATH" });
  if (version) checks.push({ name: "codex-version", status: "pass", message: version.raw });
  else checks.push({ name: "codex-version", status: resolved.bin ? "warn" : "fail", message: "version unavailable" });

  let servers: unknown[] = [];
  if (resolved.bin) {
    try {
      servers = await listServers(opts);
      checks.push({ name: "mcp-list", status: "pass", message: `${servers.length} server(s)` });
    } catch (error) {
      checks.push({ name: "mcp-list", status: "fail", message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (existsSync(resolved.configPath)) {
    const parsed = validateToml(readFileSync(resolved.configPath, "utf8"));
    checks.push({
      name: "config-parse",
      status: parsed.ok ? "pass" : "fail",
      message: parsed.ok ? resolved.configPath : parsed.error,
    });
  } else {
    checks.push({ name: "config-parse", status: "warn", message: `config not found: ${resolved.configPath}` });
  }

  const serverSummary = servers.map(server => {
    const obj = server as Record<string, unknown>;
    return { name: String(obj.name ?? "unknown"), authStatus: obj.auth_status ?? obj.authStatus };
  });
  return {
    ok: checks.every(check => check.status !== "fail"),
    codexHome: resolved.codexHome,
    configPath: resolved.configPath,
    codexBinary: resolved.bin,
    version: version?.raw ?? null,
    checks,
    servers: serverSummary,
  };
}
