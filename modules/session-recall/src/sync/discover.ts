import fs from "node:fs/promises";
import path from "node:path";
import type { DiscoveredFile, SyncOptions } from "../types.js";
import { resolveRecallPaths } from "../paths.js";

export async function discoverRolloutFiles(options: SyncOptions): Promise<DiscoveredFile[]> {
  if (options.path) {
    const absolute = path.resolve(options.path);
    const stat = await fs.stat(absolute);
    return [
      {
        path: absolute,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sizeBytes: stat.size,
        sourceBucket: "explicit_path",
      },
    ];
  }

  const { codexHome } = resolveRecallPaths(options);
  const roots: Array<{ dir: string; sourceBucket: DiscoveredFile["sourceBucket"] }> = [
    { dir: path.join(codexHome, "sessions"), sourceBucket: "sessions" },
  ];
  if (options.includeArchived) {
    roots.push({ dir: path.join(codexHome, "archived_sessions"), sourceBucket: "archived_sessions" });
  }

  const files: DiscoveredFile[] = [];
  for (const root of roots) {
    for (const filePath of await walkRolloutFiles(root.dir)) {
      if (!maybeMatchesTimeRange(filePath, options.since, options.until)) {
        continue;
      }
      const stat = await fs.stat(filePath);
      files.push({
        path: filePath,
        mtimeMs: Math.trunc(stat.mtimeMs),
        sizeBytes: stat.size,
        sourceBucket: root.sourceBucket,
      });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function parseRolloutTimestampFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath);
  const match = base.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z)-/);
  if (!match) {
    return undefined;
  }
  return match[1].replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
}

export function maybeMatchesTimeRange(filePath: string, since?: string, until?: string): boolean {
  const ts = parseRolloutTimestampFromPath(filePath);
  if (!ts) {
    return true;
  }
  const time = Date.parse(ts);
  if (Number.isNaN(time)) {
    return true;
  }
  if (since && time < Date.parse(since)) {
    return false;
  }
  if (until && time > Date.parse(until)) {
    return false;
  }
  return true;
}

async function walkRolloutFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return out;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkRolloutFiles(fullPath)));
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      out.push(fullPath);
    }
  }
  return out;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
