// Adapted from opencodex src/codex-paths.ts and src/codex-inject.ts
import { isAbsolute, resolve } from "node:path";

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function parseTomlString(raw: string): string {
  if (raw.startsWith("\"")) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw.slice(1, -1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function firstTableIndex(lines: string[]): number {
  return lines.findIndex(line => /^\s*\[/.test(line));
}

export function readRootTomlString(content: string, key: string): string | null {
  const lines = content.split("\n");
  const firstTable = firstTableIndex(lines);
  const rootLines = firstTable === -1 ? lines : lines.slice(0, firstTable);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:\\\\.|[^"])*"|'[^']*')`);
  for (const line of rootLines) {
    const match = line.match(pattern);
    if (match) return parseTomlString(match[1]!);
  }
  return null;
}

export function removeRootTomlKey(content: string, key: string, predicate?: (value: string) => boolean): string {
  const lines = content.split("\n");
  const firstTable = firstTableIndex(lines);
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:\\\\.|[^"])*"|'[^']*')\\s*$`);
  const out = lines.filter((line, index) => {
    if (index >= rootEnd) return true;
    const match = line.match(pattern);
    if (!match) return true;
    return predicate ? !predicate(parseTomlString(match[1]!)) : false;
  });
  return normalizeBlankLines(out.join("\n"));
}

export function setRootTomlString(content: string, key: string, value: string): string {
  const lines = content.split("\n");
  const firstTable = firstTableIndex(lines);
  const rootEnd = firstTable === -1 ? lines.length : firstTable;
  const rendered = `${key} = ${tomlString(value)}`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:\\\\.|[^"])*"|'[^']*')\\s*$`);
  for (let i = 0; i < rootEnd; i++) {
    if (pattern.test(lines[i]!)) {
      lines[i] = rendered;
      return lines.join("\n");
    }
  }
  if (firstTable === -1) {
    return content.replace(/\n+$/, "") + "\n" + rendered + "\n";
  }
  let insertAt = firstTable;
  while (insertAt > 0 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, rendered);
  return lines.join("\n");
}

export function normalizeBlankLines(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function resolveFromCodexHome(codexHome: string, value: string): string {
  return isAbsolute(value) ? value : resolve(codexHome, value);
}

export function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

