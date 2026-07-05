#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${MODULE_DIR}"
npm run build >/dev/null

node --input-type=module <<'NODE'
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  addServer,
  getServer,
  listServers,
  patchServer,
  patchServerText,
  plan,
  removeServer,
  rollback,
} from "./dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "codex-mcp-manager-verify-"));
const codexHome = join(tmp, "codex-home");
const configPath = join(codexHome, "config.toml");
const seedConfig = `# seed top comment
model = "gpt-5"
unrelated_key = "preserve-me"

[mcp_servers.seed_stdio]
command = "node"
args = ["-e", "process.exit(0)"]
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function getMcpServer(parsed, name) {
  return parsed?.mcp_servers?.[name];
}

function hasServer(list, name) {
  return Array.isArray(list) && list.some(server => server && typeof server === "object" && server.name === name);
}

function containsStartupTimeout(serverJson, value) {
  return JSON.stringify(serverJson).includes("startup_timeout") && JSON.stringify(serverJson).includes(String(value));
}

try {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(configPath, seedConfig);

  await check("patchServerText patches fixture TOML without a Codex CLI", async () => {
    const next = patchServerText(seedConfig, "seed_stdio", {
      startup_timeout_sec: 7,
      enabled: true,
      enabled_tools: ["read", "search"],
    });
    const parsed = parseToml(next);
    const server = getMcpServer(parsed, "seed_stdio");
    assert(server.startup_timeout_sec === 7, "startup_timeout_sec was not inserted");
    assert(server.enabled === true, "enabled was not inserted");
    assert(Array.isArray(server.enabled_tools) && server.enabled_tools.includes("search"), "enabled_tools was not inserted");
    assert(next.includes("# seed top comment"), "top-level seed comment was not preserved");
    assert(next.includes('unrelated_key = "preserve-me"'), "unrelated top-level key was not preserved");
  });

  await check("plan detects new and conflicting servers without a Codex CLI", async () => {
    const newPlan = await plan({ name: "new_stdio", command: "node" }, { codexHome, bin: null });
    assert(newPlan.ok && newPlan.status === "new", "new server plan should be ok");

    const conflictPlan = await plan({ name: "seed_stdio", command: "node" }, { codexHome, bin: null });
    assert(!conflictPlan.ok && conflictPlan.status === "conflict", "existing server plan should conflict");
  });

  await check("plaintext bearer token input is rejected", async () => {
    let rejected = false;
    try {
      await plan(
        { name: "bad_http", url: "https://mcp.example.test/mcp", bearer_token: "secret" },
        { codexHome, bin: null },
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "plaintext bearer token was accepted");
  });

  const codexProbe = spawnSync("codex", ["--version"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  const hasCodex = !codexProbe.error && codexProbe.status === 0;

  if (!hasCodex) {
    console.log("SKIP Codex CLI dependent checks: codex binary not found");
    console.log("PASS verify");
    process.exit(0);
  }

  const opts = { codexHome, timeoutMs: 15000 };

  await check("addServer adds stdio and HTTP servers while preserving seed context", async () => {
    await addServer(
      { name: "verify_stdio", command: "node", args: ["-e", "process.exit(0)"], env: { VERIFY_ONE: "1" } },
      opts,
    );
    await addServer(
      { name: "verify_http", url: "http://127.0.0.1:9/mcp", bearerTokenEnvVar: "VERIFY_HTTP_TOKEN" },
      opts,
    );

    const servers = await listServers(opts);
    assert(hasServer(servers, "verify_stdio"), "stdio server was not listed");
    assert(hasServer(servers, "verify_http"), "HTTP server was not listed");

    const afterAdd = readFileSync(configPath, "utf8");
    assert(afterAdd.includes("# seed top comment"), "top-level seed comment was not preserved after add");
    assert(afterAdd.includes('unrelated_key = "preserve-me"'), "unrelated top-level key was not preserved after add");
  });

  await check("duplicate add fails without force and succeeds with force", async () => {
    let rejected = false;
    try {
      await addServer({ name: "verify_stdio", command: "node", args: ["-e", "process.exit(0)"] }, opts);
    } catch {
      rejected = true;
    }
    assert(rejected, "duplicate add without force should fail");

    await addServer(
      { name: "verify_stdio", command: "node", args: ["-e", "process.exit(0)"], env: { VERIFY_FORCE: "1" } },
      { ...opts, force: true },
    );
    const server = await getServer("verify_stdio", opts);
    assert(server, "forced add did not leave a readable server");
  });

  await check("patchServer inserts startup_timeout_sec and Codex parses it", async () => {
    await patchServer("verify_stdio", { startup_timeout_sec: 11 }, opts);
    const parsed = parseToml(readFileSync(configPath, "utf8"));
    assert(getMcpServer(parsed, "verify_stdio").startup_timeout_sec === 11, "patched TOML lacks startup_timeout_sec");

    const server = await getServer("verify_stdio", opts);
    assert(server, "codex mcp get returned no patched server");
    assert(containsStartupTimeout(server, 11), "codex mcp get --json did not reflect startup_timeout_sec");
  });

  await check("removeServer and rollback restore the last backup byte-for-byte", async () => {
    const removed = await removeServer("verify_http", opts);
    assert(removed.backup, "remove did not create a backup");
    const backupBytes = readFileSync(removed.backup, "utf8");

    const rolledBack = await rollback(opts);
    assert(rolledBack.ok, "rollback did not report ok");
    assert(readFileSync(configPath, "utf8") === backupBytes, "rollback did not restore the remove backup bytes");
  });

  console.log("PASS verify");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
NODE
