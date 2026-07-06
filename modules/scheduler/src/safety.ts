import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isSubpath } from "./paths.js";
import { type CodexConfig, type CodexSandbox, type JobRecord } from "./types.js";

const SECRET_PATTERNS: RegExp[] = [
  /\bauth\.json\b/i,
  /\.codex\/auth\.json/i,
  /\$[{]?CODEX_HOME[}]?/i,
  /~\/\.codex\b/i,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN|CODEX_API_KEY)\b/i,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\bx-api-key\b/i,
  /\bapi_key\s*=/i,
  /\baccess_token\s*=/i,
  /BEGIN OPENSSH PRIVATE KEY/i,
  /BEGIN PRIVATE KEY/i,
  /\b(?:cat|base64)\s+[^;&|]*(?:auth\.json|\.codex)/i,
  /\b(?:curl|scp|rsync|nc)\b[^;&|]*(?:auth\.json|\.codex|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN)/i,
];

const REDACT_PATTERNS: RegExp[] = [
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN|CODEX_API_KEY)=\S+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,})\b/g,
  /-----BEGIN (?:OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH )?PRIVATE KEY-----/g,
];

export function scanCredentialExfil(text: string | null | undefined, context = "value"): void {
  if (!text) return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`Credential guard blocked ${context}`);
  }
}

export function assertSafeJob(job: JobRecord, opts: { storeDir: string }): void {
  scanCredentialExfil(job.name, "job name");
  scanCredentialExfil(job.scheduleInput, "schedule input");
  if (job.cwd) assertSafeCwd(job.cwd);
  assertSafeCodexConfig(job.codex);
  if (job.script) {
    scanCredentialExfil(job.script.path, "script path");
    const root = realpathSync(join(opts.storeDir, "scripts"));
    const scriptPath = assertSafeScriptPath(job.script.path, root);
    if (existsSync(scriptPath)) scanCredentialExfil(readFileSync(scriptPath, "utf8"), "script content");
  }
  scanCredentialExfil(job.codex.prompt, "prompt");
}

export function assertSafeCodexConfig(codex: CodexConfig | Partial<CodexConfig>): void {
  const sandbox = codex.sandbox ?? "read-only";
  assertSafeSandbox(sandbox);
  for (const value of [codex.prompt, codex.model, codex.effort]) {
    scanCredentialExfil(value ?? null, "codex config");
    if (value && /(?:danger|bypass|approval|sandbox_permissions|danger-full-access)/i.test(value)) {
      throw new Error("Unsafe Codex config value");
    }
  }
}

export function assertSafeSandbox(value: string): asserts value is CodexSandbox {
  if (value !== "read-only" && value !== "workspace-write") throw new Error(`Unsupported sandbox: ${value}`);
}

export function assertNoForbiddenArgv(args: string[]): void {
  for (const arg of args) {
    if (arg === "-a" || arg === "--ask-for-approval" || arg.startsWith("--dangerously-") || arg === "danger-full-access") {
      throw new Error(`Forbidden Codex argv: ${arg}`);
    }
  }
}

export function assertSafeScriptPath(scriptPath: string, scriptRoot: string): string {
  const candidate = isAbsolute(scriptPath) ? scriptPath : resolve(scriptRoot, scriptPath);
  const parentReal = realpathSync(scriptRoot);
  const existingReal = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (!isSubpath(existingReal, parentReal)) throw new Error(`Script path escapes script root: ${scriptPath}`);
  if (!existsSync(existingReal)) throw new Error(`Script does not exist: ${scriptPath}`);
  if (!statSync(existingReal).isFile()) throw new Error(`Script is not a file: ${scriptPath}`);
  return existingReal;
}

export function assertSafeCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error(`cwd must be absolute: ${cwd}`);
  const real = realpathSync(cwd);
  const home = homedir();
  const denied = [
    join(home, ".codex"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config"),
    "/etc",
  ].filter(path => existsSync(path)).map(path => realpathSync(path));
  for (const root of denied) {
    if (isSubpath(real, root)) throw new Error(`cwd points inside a sensitive directory: ${cwd}`);
  }
  return real;
}

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env, opts: { codexHome?: string } = {}): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed.has(key) || key.startsWith("LC_")) result[key] = value;
  }
  if (opts.codexHome) result.CODEX_HOME = opts.codexHome;
  return result;
}

export function sanitizeScriptEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = sanitizeEnv(env);
  for (const key of Object.keys(result)) {
    if (/(?:_KEY|_TOKEN|_SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL)/i.test(key)) delete result[key];
  }
  return result;
}

export function redactSensitiveText(text: string): string {
  try {
    let out = text;
    for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, "[REDACTED]");
    return out;
  } catch {
    return "[REDACTED - redaction failed]";
  }
}
