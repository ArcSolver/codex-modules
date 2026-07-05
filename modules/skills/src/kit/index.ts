// Adapted from modules/config-kit/src/index.ts
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

export type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type CodexVersion = {
  raw: string;
  version: [number, number, number];
};

export type CodexFeature = {
  name: string;
  stage: string;
  enabled: boolean;
};

export type ManagedBlock = {
  owner: string;
  blockId: string;
  body: string;
};

export type TomlValidation =
  | { ok: true }
  | { ok: false; error: string };

export type ChangeRecord = {
  ts: string;
  action: string;
  file: string;
  backup?: string | null;
  [key: string]: unknown;
};

export type WriteJsonOptions = {
  backup?: boolean | string;
};

export type ListFeaturesOptions = {
  bin?: string | null;
  env?: Env;
  timeoutMs?: number;
};

export type AppServerRequestOptions = {
  codexHome?: string;
  bin?: string | null;
  timeoutMs?: number;
};

let atomicSeq = 0;

export function resolveCodexHome(env: Env = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), ".codex");
}

export function findCodexBinary(env: Env = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return null;

  const candidateNames =
    process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidateNames) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

export function getCodexVersion(bin: string | null = findCodexBinary()): CodexVersion | null {
  if (!bin) return null;
  const result = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;

  const raw = `${result.stdout}${result.stderr}`.trim();
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    raw,
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

export function listFeatures(opts: ListFeaturesOptions = {}): CodexFeature[] {
  const bin = opts.bin === undefined ? findCodexBinary(opts.env) : opts.bin;
  if (!bin) return [];

  const result = spawnSync(bin, ["features", "list"], {
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 5000,
  });
  if (result.status !== 0 || result.error) {
    const reason = result.error ? result.error.message : result.stderr.trim();
    throw new Error(`codex features list failed${reason ? `: ${reason}` : ""}`);
  }

  const features: CodexFeature[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(.+)\s+(true|false)$/i);
    if (!match) continue;
    features.push({
      name: match[1]!,
      stage: match[2]!.trim(),
      enabled: match[3]!.toLowerCase() === "true",
    });
  }
  return features;
}

export function backupFile(filePath: string, backupDir = join(dirname(filePath), ".codex-kit-backups")): string | null {
  if (!existsSync(filePath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `${basename(filePath)}.${stamp}.${process.pid}.bak`);
  copyFileSync(filePath, backupPath);
  try {
    chmodSync(backupPath, statSync(filePath).mode & 0o777);
  } catch {
    // The copy already succeeded; mode preservation is best effort.
  }
  return backupPath;
}

export function writeFileAtomic(filePath: string, content: string | Buffer): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600;
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${++atomicSeq}.tmp`);
  try {
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonAtomic(path: string, value: unknown, opts: WriteJsonOptions = {}): string | null {
  let backup: string | null = null;
  if (opts.backup) {
    backup = backupFile(path, typeof opts.backup === "string" ? opts.backup : undefined);
  }
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  return backup;
}

export function renderManagedBlock(owner: string, blockId: string, body: string): string {
  const normalizedBody = body.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  const header = `# >>> ${owner}:${blockId} managed`;
  const footer = `# <<< ${owner}:${blockId}`;
  return normalizedBody.length > 0 ? `${header}\n${normalizedBody}\n${footer}\n` : `${header}\n${footer}\n`;
}

export function spliceManagedBlock(content: string, owner: string, blockId: string, newBody: string | null): string {
  const header = `# >>> ${owner}:${blockId} managed`;
  const footer = `# <<< ${owner}:${blockId}`;
  const blockPattern = new RegExp(
    `(^|\\n)${escapeRegExp(header)}\\r?\\n[\\s\\S]*?\\r?\\n${escapeRegExp(footer)}(?=\\n|$)`,
    "g",
  );

  const replacement = newBody === null ? "" : renderManagedBlock(owner, blockId, newBody).replace(/\n$/u, "");
  let replaced = false;
  const next = content.replace(blockPattern, (match, prefix: string) => {
    if (replaced) return "";
    replaced = true;
    if (newBody === null) {
      return prefix === "\n" && match.endsWith(footer) ? prefix.trimEnd() : prefix;
    }
    return `${prefix}${replacement}`;
  });

  if (replaced || newBody === null) return collapseExcessBlankLineAfterRemoval(next, newBody);
  return content.length === 0
    ? renderManagedBlock(owner, blockId, newBody)
    : `${content}${content.endsWith("\n") ? "" : "\n"}${renderManagedBlock(owner, blockId, newBody)}`;
}

export function listManagedBlocks(content: string, owner?: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  const pattern = /^# >>> ([^:\r\n]+):([^\r\n]+) managed\r?\n([\s\S]*?)^# <<< \1:\2\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const blockOwner = match[1]!;
    if (owner && blockOwner !== owner) continue;
    blocks.push({
      owner: blockOwner,
      blockId: match[2]!,
      body: match[3]!.replace(/\r?\n$/u, ""),
    });
  }
  return blocks;
}

export function validateToml(content: string): TomlValidation {
  try {
    parseToml(content);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function insertUnderTomlTable(content: string, tablePath: string, lines: string[]): string {
  const parsedBefore = validateToml(content);
  if (!parsedBefore.ok) throw new Error(`input TOML is invalid: ${parsedBefore.error}`);

  const header = `[${tablePath}]`;
  const hadTrailingNewline = content.endsWith("\n");
  const split = content.split("\n");
  const logicalLines = hadTrailingNewline ? split.slice(0, -1) : split;
  const tableIndex = logicalLines.findIndex(line => line.trim() === header);
  if (tableIndex === -1) throw new Error(`TOML table not found: ${header}`);

  let insertAt = logicalLines.length;
  for (let i = tableIndex + 1; i < logicalLines.length; i++) {
    if (/^\s*\[{1,2}[^\]]+\]{1,2}\s*(?:#.*)?\r?$/.test(logicalLines[i]!)) {
      insertAt = i;
      break;
    }
  }
  while (insertAt > tableIndex + 1 && logicalLines[insertAt - 1]!.trim() === "") {
    insertAt--;
  }

  const sanitizedLines = lines.map(line => line.replace(/\r?\n$/u, ""));
  logicalLines.splice(insertAt, 0, ...sanitizedLines);
  const next = `${logicalLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
  const parsedAfter = validateToml(next);
  if (!parsedAfter.ok) throw new Error(`inserted TOML is invalid: ${parsedAfter.error}`);
  return next;
}

export function appendChange(manifestPath: string, change: ChangeRecord): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  appendFileSync(manifestPath, `${JSON.stringify(change)}\n`, "utf8");
}

export function readChanges(manifestPath: string): ChangeRecord[] {
  if (!existsSync(manifestPath)) return [];
  const raw = readFileSync(manifestPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as ChangeRecord);
}

export async function appServerRequest<T = unknown>(
  method: string,
  params: unknown = {},
  opts: AppServerRequestOptions = {},
): Promise<T> {
  const bin = opts.bin === undefined ? findCodexBinary() : opts.bin;
  if (!bin) throw new Error("codex binary not found");

  const env = { ...process.env };
  if (opts.codexHome) env.CODEX_HOME = opts.codexHome;

  return new Promise<T>((resolve, reject) => {
    const child = spawn(bin, ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`codex app-server request timed out after ${opts.timeoutMs ?? 5000}ms`));
    }, opts.timeoutMs ?? 5000);

    let stdoutBuffer = "";
    let stderr = "";
    let requestSent = false;
    let settled = false;

    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(value as T);
    };

    const send = (payload: unknown) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    child.once("error", error => finish(error));
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }

        if (message.id === 1 && !requestSent) {
          requestSent = true;
          send({ jsonrpc: "2.0", id: 2, method, params });
          continue;
        }
        if (message.id !== 2) continue;
        if ("error" in message && message.error) {
          finish(new Error(`codex app-server ${method} failed: ${JSON.stringify(message.error)}`));
          return;
        }
        finish(null, message.result as T);
      }
    });
    child.once("close", code => {
      if (!settled) {
        finish(new Error(`codex app-server exited before response${code === null ? "" : ` (${code})`}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-config-kit",
          title: "Codex Config Kit",
          version: "0.1.0",
        },
      },
    });
  });
}

type JsonRpcMessage = {
  id?: number | string;
  result?: unknown;
  error?: unknown;
  method?: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collapseExcessBlankLineAfterRemoval(content: string, newBody: string | null): string {
  if (newBody !== null) return content;
  return content.replace(/\n{3,}/g, "\n\n");
}
