// Adapted from opencodex src/codex-inject.ts
import { SECTION_MARKER } from "./constants.js";
import { normalizeBlankLines, parseTomlString, readRootTomlString, removeRootTomlKey, setRootTomlString, tomlString } from "./toml.js";

export type ProviderTableOptions = {
  providerId: string;
  providerName?: string;
  baseUrl: string;
  requiresOpenaiAuth?: boolean;
  envHttpHeaders?: Record<string, string>;
};

function tomlKeySegment(value: string): string {
  return tomlString(value);
}

export function providerTableHeader(providerId: string): string {
  return `[model_providers.${tomlKeySegment(providerId)}]`;
}

function providerIdFromTableHeader(line: string): string | null {
  const trimmed = line.trim();
  const quoted = trimmed.match(/^\[model_providers\."((?:\\.|[^"])*)"\]$/);
  if (quoted) return parseTomlString(`"${quoted[1]!}"`);
  const singleQuoted = trimmed.match(/^\[model_providers\.'([^']*)'\]$/);
  if (singleQuoted) return singleQuoted[1]!;
  const bare = trimmed.match(/^\[model_providers\.([A-Za-z0-9_-]+)\]$/);
  if (bare) return bare[1]!;
  return null;
}

function nextNonBlankProviderHeader(lines: string[], start: number): string | null {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    return providerIdFromTableHeader(lines[i]!);
  }
  return null;
}

export function hasProviderTable(content: string, providerId: string): boolean {
  return content.split("\n").some(line => providerIdFromTableHeader(line) === providerId);
}

export function hasOwnedProviderTable(content: string, providerId: string): boolean {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (providerIdFromTableHeader(lines[i]!) !== providerId) continue;
    let previous = i - 1;
    while (previous >= 0 && lines[previous]!.trim() === "") previous--;
    if (previous >= 0 && lines[previous]!.trim() === SECTION_MARKER) return true;
  }
  return false;
}

export function stripProviderSection(content: string, providerId: string, includeUnmarked = false): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const lineProvider = providerIdFromTableHeader(line);
    const markerStartsOwnedSection = line.trim() === SECTION_MARKER
      && nextNonBlankProviderHeader(lines, index + 1) === providerId;
    const startsSection = lineProvider === providerId && (includeUnmarked || hasMarkerImmediatelyBefore(lines, index));

    if (markerStartsOwnedSection || startsSection) {
      index++;
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (/^\s*\[/.test(candidate) && providerIdFromTableHeader(candidate) !== providerId) break;
        index++;
      }
      continue;
    }

    out.push(line);
    index++;
  }
  return normalizeBlankLines(out.join("\n"));
}

function hasMarkerImmediatelyBefore(lines: string[], index: number): boolean {
  let previous = index - 1;
  while (previous >= 0 && lines[previous]!.trim() === "") previous--;
  return previous >= 0 && lines[previous]!.trim() === SECTION_MARKER;
}

export function buildProviderTableBlock(options: ProviderTableOptions): string {
  const lines = [
    "",
    SECTION_MARKER,
    providerTableHeader(options.providerId),
    `name = ${tomlString(options.providerName ?? options.providerId)}`,
    `base_url = ${tomlString(options.baseUrl)}`,
    'wire_api = "responses"',
    `requires_openai_auth = ${options.requiresOpenaiAuth ?? true}`,
  ];
  if (options.envHttpHeaders && Object.keys(options.envHttpHeaders).length > 0) {
    const rendered = Object.entries(options.envHttpHeaders)
      .map(([name, envVar]) => `${tomlString(name)} = ${tomlString(envVar)}`)
      .join(", ");
    lines.push(`env_http_headers = { ${rendered} }`);
  }
  return lines.join("\n") + "\n";
}

export function injectProviderTable(content: string, options: ProviderTableOptions, includeUnmarked = false): string {
  const stripped = stripProviderSection(content, options.providerId, includeUnmarked);
  return stripped.trimEnd() + "\n" + buildProviderTableBlock(options);
}

export function rootModelProvider(content: string): string | null {
  return readRootTomlString(content, "model_provider");
}

export function rootModelCatalogPath(content: string): string | null {
  return readRootTomlString(content, "model_catalog_json");
}

export function setRootModelProvider(content: string, providerId: string): string {
  return setRootTomlString(content, "model_provider", providerId);
}

export function setRootModelCatalogPath(content: string, catalogPath: string): string {
  return setRootTomlString(content, "model_catalog_json", catalogPath);
}

export function removeRootModelProviderIf(content: string, providerId: string): string {
  return removeRootTomlKey(content, "model_provider", value => value === providerId);
}

export function removeRootModelCatalogIf(content: string, predicate: (path: string) => boolean): string {
  return removeRootTomlKey(content, "model_catalog_json", predicate);
}

