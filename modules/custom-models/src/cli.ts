#!/usr/bin/env node
import {
  doctor,
  listModels,
  planRegister,
  registerModels,
  removeModels,
  rollback,
  type CustomModelSpec,
  type RegisterOptions,
} from "./index.js";

type Parsed = {
  command?: string;
  flags: Map<string, string[]>;
};

function parseArgv(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const flags = new Map<string, string[]>();
  let index = 0;
  while (index < rest.length) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const booleanFlag = new Set([
      "all",
      "dry-run",
      "force",
      "help",
      "json",
      "no-backup",
      "no-requires-openai-auth",
      "set-default",
      "vision",
    ]).has(name);
    let value = "true";
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else if (!booleanFlag) {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for --${name}`);
      value = next;
      index++;
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
    index++;
  }
  return { command, flags };
}

function has(flags: Map<string, string[]>, name: string): boolean {
  return flags.has(name);
}

function one(flags: Map<string, string[]>, name: string): string | undefined {
  return flags.get(name)?.at(-1);
}

function many(flags: Map<string, string[]>, name: string): string[] {
  return flags.get(name) ?? [];
}

function boolValue(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Expected true or false, got "${raw}"`);
}

function common(flags: Map<string, string[]>): { codexHome?: string; stateDir?: string } {
  return {
    codexHome: one(flags, "codex-home"),
    stateDir: one(flags, "state-dir"),
  };
}

function parseHeaders(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const value of values) {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) throw new Error(`--header-env must look like Header-Name=ENV_VAR, got "${value}"`);
    headers[value.slice(0, split)] = value.slice(split + 1);
  }
  return headers;
}

function parseModels(flags: Map<string, string[]>): CustomModelSpec[] {
  const slugs = many(flags, "model");
  const contextWindow = one(flags, "context-window");
  const reasoning = one(flags, "reasoning");
  const shared: Omit<CustomModelSpec, "slug"> = {
    ...(contextWindow ? { contextWindow: Number.parseInt(contextWindow, 10) } : {}),
    ...(reasoning !== undefined ? { reasoningEfforts: reasoning.length === 0 ? [] : reasoning.split(",").map(value => value.trim()).filter(Boolean) } : {}),
    ...(has(flags, "vision") ? { inputModalities: ["text", "image"] } : {}),
  };
  return slugs.map(slug => ({ slug, ...shared }));
}

function requireValue(flags: Map<string, string[]>, name: string): string {
  const value = one(flags, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function addOptions(flags: Map<string, string[]>): RegisterOptions {
  const requiresOpenaiAuth = has(flags, "no-requires-openai-auth")
    ? false
    : boolValue(one(flags, "requires-openai-auth"), true);
  return {
    ...common(flags),
    providerId: requireValue(flags, "provider"),
    providerName: one(flags, "name"),
    baseUrl: requireValue(flags, "base-url"),
    models: parseModels(flags),
    catalogPath: one(flags, "catalog-path"),
    profileName: one(flags, "profile-name"),
    requiresOpenaiAuth,
    envHttpHeaders: parseHeaders(many(flags, "header-env")),
    setDefaultProvider: has(flags, "set-default"),
    dryRun: has(flags, "dry-run"),
    force: has(flags, "force"),
    backup: !has(flags, "no-backup"),
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printPlan(plan: Awaited<ReturnType<typeof planRegister>>): void {
  console.log(`Provider: ${plan.providerId}`);
  console.log(`Codex home: ${plan.codexHome}`);
  console.log(`Catalog: ${plan.catalogPath}`);
  console.log("Models:");
  for (const slug of plan.routedSlugs) console.log(`  ${slug}`);
  console.log("Changes:");
  for (const change of plan.changes) console.log(`  ${change}`);
}

function help(command?: string): string {
  if (command === "add") return `Usage:
  codex-custom-models add --provider ID --base-url URL --model SLUG [--model SLUG]

Options:
  --name NAME                       Provider display name
  --codex-home PATH                 Override CODEX_HOME
  --catalog-path PATH               Catalog path, default CODEX_HOME/codex-custom-models-catalog.json
  --set-default                     Set root model_provider to this provider
  --requires-openai-auth true|false Provider table flag, default true
  --no-requires-openai-auth         Shortcut for --requires-openai-auth false
  --header-env Header=ENV_VAR       Add env_http_headers entry, repeatable
  --context-window N                Apply a context window hint to all supplied models
  --reasoning low,medium,high       Apply Codex reasoning labels to all supplied models
  --vision                          Set input_modalities to text,image
  --force                           Override conflicting root provider/catalog or provider table
  --dry-run                         Print the plan without writing files
  --json                            Print JSON output`;
  if (command === "remove") return `Usage:
  codex-custom-models remove --provider ID --model SLUG
  codex-custom-models remove --provider ID --all

Options:
  --codex-home PATH
  --model SLUG                      Upstream or routed slug, repeatable
  --all                             Remove every model owned by this provider
  --dry-run
  --json`;
  return `Usage:
  codex-custom-models <command> [options]

Commands:
  add       Register custom model slugs
  list      List models tracked by codex-custom-models
  remove    Remove state-owned model slugs
  rollback  Restore files from a transaction journal
  doctor    Check config, catalog, state, and cache health

Run codex-custom-models <command> --help for command options.`;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const command = parsed.command;
  const flags = parsed.flags;
  if (!command || has(flags, "help") || command === "--help" || command === "help") {
    console.log(help(command === "help" ? undefined : command));
    return;
  }

  const json = has(flags, "json");
  if (command === "add") {
    const options = addOptions(flags);
    if (options.dryRun) {
      const plan = await planRegister(options);
      if (json) printJson(plan);
      else printPlan(plan);
      if (!plan.ok) process.exitCode = 1;
      return;
    }
    const result = await registerModels(options);
    if (json) printJson(result);
    else {
      console.log(`Registered ${result.added.length} model(s) for provider ${result.plan.providerId}.`);
      console.log(`Catalog: ${result.catalogPath}`);
      if (result.transactionId) console.log(`Rollback transaction: ${result.transactionId}`);
    }
    return;
  }

  if (command === "list") {
    const result = await listModels({ ...common(flags), providerId: one(flags, "provider") });
    if (json) printJson(result);
    else if (result.providers.length === 0) {
      console.log("No codex-custom-models providers are registered.");
    } else {
      for (const provider of result.providers) {
        console.log(`${provider.providerId} (${provider.baseUrl})`);
        for (const slug of provider.ownedSlugs) console.log(`  ${slug}`);
      }
    }
    return;
  }

  if (command === "remove") {
    const providerId = requireValue(flags, "provider");
    const slugs = many(flags, "model");
    if (!has(flags, "all") && slugs.length === 0) throw new Error("remove requires --model or --all");
    const result = await removeModels({
      ...common(flags),
      providerId,
      slugs: has(flags, "all") ? undefined : slugs,
      dryRun: has(flags, "dry-run"),
      backup: !has(flags, "no-backup"),
    });
    if (json) printJson(result);
    else {
      console.log(`${result.applied ? "Removed" : "Would remove"} ${result.removed.length} model(s) for provider ${providerId}.`);
      if (result.transactionId) console.log(`Rollback transaction: ${result.transactionId}`);
    }
    return;
  }

  if (command === "rollback") {
    const result = await rollback({ ...common(flags), transactionId: one(flags, "transaction") });
    if (json) printJson(result);
    else if (result.missing) console.log("No rollback journal found.");
    else {
      console.log(result.complete ? `Rolled back transaction ${result.transactionId}.` : `Rollback incomplete for ${result.transactionId}.`);
      for (const skipped of result.skipped) console.log(`Skipped ${skipped.path}: ${skipped.reason}`);
    }
    return;
  }

  if (command === "doctor") {
    const result = await doctor(common(flags));
    if (json) printJson(result);
    else {
      for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command "${command}"`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

