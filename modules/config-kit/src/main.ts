import { readFileSync } from "node:fs";
import {
  backupFile,
  findCodexBinary,
  getCodexVersion,
  listFeatures,
  validateToml,
} from "./index.js";

export async function main(args: string[]): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const json = rest.includes("--json");
    const bin = findCodexBinary();
    const version = getCodexVersion(bin);
    let features: unknown[] = [];
    let featuresError: string | null = null;
    if (bin) {
      try {
        features = listFeatures({ bin });
      } catch (error) {
        featuresError = error instanceof Error ? error.message : String(error);
      }
    }

    const result = { codexBinary: bin, version, features, featuresError };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`codex binary: ${bin ?? "not found"}`);
    console.log(`version: ${version ? version.raw : "unknown"}`);
    if (featuresError) console.log(`features: unavailable (${featuresError})`);
    else console.log(`features: ${features.length}`);
    return;
  }

  if (command === "validate-toml") {
    const file = rest[0];
    if (!file) throw new Error("usage: codex-config-kit validate-toml <file>");
    const result = validateToml(readFileSync(file, "utf8"));
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log("OK");
    return;
  }

  if (command === "backup") {
    const file = rest[0];
    if (!file) throw new Error("usage: codex-config-kit backup <file>");
    const backup = backupFile(file);
    if (!backup) throw new Error(`file not found: ${file}`);
    console.log(backup);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function printHelp(): void {
  console.log(`codex-config-kit

Usage:
  codex-config-kit doctor [--json]
  codex-config-kit validate-toml <file>
  codex-config-kit backup <file>`);
}
