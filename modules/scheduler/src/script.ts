import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { outputPaths, resolveScriptRoot } from "./paths.js";
import { assertSafeScriptPath, redactSensitiveText, sanitizeScriptEnv } from "./safety.js";
import { type JobRecord, type OutputStatus, type RunOptions } from "./types.js";

const MAX_CAPTURE = 1_000_000;

export type ScriptResult = {
  status: OutputStatus;
  stdout: string;
  stderr: string;
  error?: string;
  wakeAgent: boolean;
};

export function parseWakeGate(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]!);
    return !(parsed && typeof parsed === "object" && parsed.wakeAgent === false);
  } catch {
    return true;
  }
}

export function buildScriptArgv(scriptPath: string): { command: string; args: string[] } {
  const ext = extname(scriptPath);
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { command: process.execPath, args: [scriptPath] };
  if (ext === ".sh" || ext === ".bash") return { command: "bash", args: [scriptPath] };
  throw new Error(`Unsupported script extension for ${basename(scriptPath)}`);
}

export async function runJobScript(job: JobRecord, storeDir: string, runId: string, opts: RunOptions = {}): Promise<ScriptResult> {
  if (!job.script) throw new Error("Job has no script");
  const scriptRoot = resolveScriptRoot(storeDir);
  const scriptPath = assertSafeScriptPath(job.script.path, scriptRoot);
  const { command, args } = buildScriptArgv(scriptPath);
  const paths = outputPaths(storeDir, job.id, runId);
  const devNull = openSync(process.platform === "win32" ? "NUL" : "/dev/null", "r");
  const child = spawn(command, args, {
    cwd: job.cwd ?? storeDir,
    env: sanitizeScriptEnv(process.env),
    stdio: [devNull, "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let killedStatus: OutputStatus | null = null;
  const timeoutMs = (job.script.timeoutSec || opts.timeoutSec || 60) * 1000;
  const timeout = setTimeout(() => {
    killedStatus = "timeout";
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1000).unref();
  }, timeoutMs);
  child.stdout?.on("data", chunk => {
    stdout = keepTail(stdout + chunk.toString("utf8"));
  });
  child.stderr?.on("data", chunk => {
    stderr = keepTail(stderr + chunk.toString("utf8"));
  });
  try {
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    clearTimeout(timeout);
    const safeOut = redactSensitiveText(stdout);
    const safeErr = redactSensitiveText(stderr);
    writeFileSync(paths.scriptStdout, safeOut);
    writeFileSync(paths.scriptStderr, safeErr);
    const status: OutputStatus = killedStatus ?? (code === 0 ? "ok" : "error");
    return {
      status,
      stdout: safeOut,
      stderr: safeErr,
      error: status === "ok" ? undefined : `script exited with ${code ?? signal}`,
      wakeAgent: job.script.wakeGate === false ? true : parseWakeGate(safeOut),
    };
  } finally {
    closeSync(devNull);
  }
}

export function writeNoAgentOutput(storeDir: string, job: JobRecord, runId: string, stdout: string): void {
  writeFileSync(outputPaths(storeDir, job.id, runId).output, stdout);
}

function keepTail(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_CAPTURE) return value;
  return `[truncated]\n${value.slice(-MAX_CAPTURE)}`;
}
