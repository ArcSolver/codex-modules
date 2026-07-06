import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { DoctorReport } from "./types.js";
import { findCodexBinary, listInstalledTeams, resolveAgentsRoot, resolveCodexHome } from "./agents.js";
import { resolveStateRoot } from "./state.js";

export type DoctorOptions = {
  codexHome?: string;
  stateDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export function doctor(opts: DoctorOptions = {}): DoctorReport {
  const env = opts.env ?? process.env;
  const codexHome = resolveCodexHome(env, opts.codexHome);
  const bin = findCodexBinary(env);
  const version = bin ? getCodexVersion(bin) : null;
  let features: DoctorReport["features"] = [];
  let featuresError: string | undefined;
  if (bin) {
    try {
      features = listFeatures(bin, { ...process.env, ...env, CODEX_HOME: codexHome });
    } catch (error) {
      featuresError = error instanceof Error ? error.message : String(error);
    }
  }
  const multiAgent = featureState(features, "multi_agent");
  const fanout = featureState(features, "enable_fanout");
  const multiAgentV2 = featureState(features, "multi_agent_v2");
  const agentsRoot = resolveAgentsRoot("user", { codexHome, env });
  const stateRoot = resolveStateRoot({ cwd: opts.cwd, stateDir: opts.stateDir, env });
  return {
    codexBinary: bin,
    version,
    features,
    featuresError,
    multiAgent,
    fanout,
    multiAgentV2,
    models: bin ? debugModels(bin, { ...process.env, ...env, CODEX_HOME: codexHome }) : { ok: false, values: [], error: "codex binary not found" },
    agentsDirWritable: canWriteDir(agentsRoot),
    stateDirWritable: canWriteDir(stateRoot),
    installedTeams: existsSync(agentsRoot) ? listInstalledTeams(agentsRoot) : [],
  };
}

export function doctorIsHealthy(report: DoctorReport): boolean {
  return Boolean(report.codexBinary && report.multiAgent.present && report.multiAgent.stage === "stable" && report.multiAgent.enabled);
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    `codex binary: ${report.codexBinary ?? "not found"}`,
    `version: ${report.version ?? "unknown"}`,
    `multi_agent: ${formatFeature(report.multiAgent)}`,
    `enable_fanout: ${formatFeature(report.fanout)} (under development - report only)`,
    `multi_agent_v2: ${formatFeature(report.multiAgentV2)} (under development - report only)`,
    report.featuresError ? `features error: ${report.featuresError}` : null,
    report.models.ok ? `models: ${report.models.values.length}` : `models: unavailable (${report.models.error ?? "unknown error"})`,
    `agents dir writable: ${report.agentsDirWritable}`,
    `state dir writable: ${report.stateDirWritable}`,
    `installed teams: ${report.installedTeams.length ? report.installedTeams.join(", ") : "none"}`,
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\n")}\n`;
}

function getCodexVersion(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  if (result.status !== 0 || result.error) return null;
  return `${result.stdout}${result.stderr}`.trim() || null;
}

function listFeatures(bin: string, env: NodeJS.ProcessEnv): DoctorReport["features"] {
  const result = spawnSync(bin, ["features", "list"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  if (result.status !== 0 || result.error) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    throw new Error(`codex features list failed${reason ? `: ${reason}` : ""}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const match = line.match(/^(\S+)\s+(.+)\s+(true|false)$/i);
      if (!match) return [];
      return [{ name: match[1]!, stage: match[2]!.trim(), enabled: match[3]!.toLowerCase() === "true" }];
    });
}

function debugModels(bin: string, env: NodeJS.ProcessEnv): DoctorReport["models"] {
  const result = spawnSync(bin, ["debug", "models"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (result.status !== 0 || result.error) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    return { ok: false, values: [], error: reason || "codex debug models failed" };
  }
  const values = [...new Set([...result.stdout.matchAll(/\b(?:gpt|o)[A-Za-z0-9_.:-]+\b/g)].map(match => match[0]))].sort();
  return { ok: true, values };
}

function featureState(features: DoctorReport["features"], name: string): DoctorReport["multiAgent"] {
  const found = features.find(feature => feature.name === name);
  return found ? { present: true, stage: found.stage, enabled: found.enabled } : { present: false };
}

function formatFeature(feature: DoctorReport["multiAgent"] | undefined): string {
  if (!feature || !feature.present) return "not reported";
  return `${feature.stage ?? "unknown"} enabled=${feature.enabled ?? false}`;
}

function canWriteDir(dir: string): boolean {
  try {
    const target = nearestExistingPath(dir);
    if (!statSync(target).isDirectory()) return false;
    accessSync(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingPath(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
