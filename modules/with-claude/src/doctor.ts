import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAnthropicApiKeyAllowed } from "./security.js";
import { manifestPathFor } from "./install.js";
import type { DoctorCheck, DoctorOptions, DoctorReport } from "./types.js";

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, message: string) => checks.push({ name, ok, message });
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  add("node", major >= 24, `Node ${process.versions.node}`);
  try {
    assertAnthropicApiKeyAllowed();
    add("anthropic_api_key_shadowing", true, "ANTHROPIC_API_KEY is not shadowing Claude Code auth");
  } catch (error) {
    add("anthropic_api_key_shadowing", false, error instanceof Error ? error.message : String(error));
  }

  const packageJson = await readPackageJson();
  for (const name of ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"]) {
    const version = packageJson.dependencies?.[name];
    add(`dependency:${name}`, Boolean(version), version ? `${name}@${version}` : `${name} missing from package.json`);
  }

  const codexHome = options.codexHome ?? process.env.CODEX_HOME;
  if (codexHome) {
    const configPath = join(codexHome, "config.toml");
    const manifestPath = manifestPathFor(codexHome);
    add("codex_home", true, codexHome);
    add("config.toml", existsSync(configPath), configPath);
    add("install_manifest", existsSync(manifestPath), manifestPath);
    if (existsSync(configPath)) {
      const config = await readFile(configPath, "utf8");
      add("provider_block", config.includes("[model_providers.with_claude]"), "provider block lookup");
      add("wire_api", config.includes('wire_api = "responses"'), "wire_api responses lookup");
    }
  } else {
    add("codex_home", true, "--codex-home or CODEX_HOME not provided; real ~/.codex was not inspected");
  }

  if (options.baseUrl) {
    try {
      const healthUrl = new URL("../healthz", options.baseUrl).toString();
      const response = await fetch(healthUrl);
      add("healthz", response.ok, `${response.status} ${healthUrl}`);
    } catch (error) {
      add("healthz", false, error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function readPackageJson(): Promise<{ dependencies?: Record<string, string> }> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const path = join(here, "..", "package.json");
  return JSON.parse(await readFile(path, "utf8")) as { dependencies?: Record<string, string> };
}
