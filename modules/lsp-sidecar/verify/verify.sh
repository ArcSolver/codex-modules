#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run build

TMP="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

WORKSPACE="$TMP/workspace"
mkdir -p "$WORKSPACE/src" "$WORKSPACE/node_modules"

cat > "$WORKSPACE/package.json" <<'JSON'
{
  "name": "lsp-sidecar-verify-workspace",
  "private": true,
  "type": "module",
  "devDependencies": {
    "typescript": "*"
  }
}
JSON

cat > "$WORKSPACE/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*.ts"]
}
JSON

cat > "$WORKSPACE/src/index.ts" <<'TS'
const value: string = 1;
export { value };
TS

if [[ ! -d "$ROOT/node_modules/typescript" ]]; then
  echo "SKIP diagnostics: module dev dependency typescript not installed"
  exit 0
fi

ln -s "$ROOT/node_modules/typescript" "$WORKSPACE/node_modules/typescript"

node --input-type=module - "$ROOT" "$WORKSPACE" <<'NODE'
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [root, workspace] = process.argv.slice(2)
const moduleBin = path.join(root, "node_modules", ".bin")
const tlsNames = process.platform === "win32"
  ? ["typescript-language-server.cmd", "typescript-language-server.exe", "typescript-language-server"]
  : ["typescript-language-server"]
const hasModuleTls = tlsNames.some((name) => fs.existsSync(path.join(moduleBin, name)))
const hasPathTls = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter(Boolean)
  .some((dir) => tlsNames.some((name) => fs.existsSync(path.join(dir, name))))
const diagnosticsAvailable = hasModuleTls || hasPathTls

function frame(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

class Reader {
  buffer = Buffer.alloc(0)
  waiting = []

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  next() {
    return new Promise((resolve) => {
      this.waiting.push(resolve)
      this.drain()
    })
  }

  drain() {
    while (this.waiting.length) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const line = header.split("\r\n").find((item) => item.toLowerCase().startsWith("content-length:"))
      if (!line) throw new Error("missing content-length")
      const length = Number(line.slice(line.indexOf(":") + 1).trim())
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) return
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")
      this.buffer = this.buffer.subarray(bodyEnd)
      const resolve = this.waiting.shift()
      resolve(JSON.parse(body))
    }
  }
}

const child = spawn(process.execPath, [path.join(root, "dist", "cli.js"), "serve", "--root", workspace], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PATH: `${moduleBin}${path.delimiter}${process.env.PATH ?? ""}`,
  },
})

let stderr = ""
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString()
})

const reader = new Reader()
child.stdout.on("data", (chunk) => reader.push(chunk))

let nextId = 1
async function request(method, params) {
  const id = nextId++
  child.stdin.write(frame({ id, method, params }))
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000))
  const message = await Promise.race([reader.next(), timeout])
  if (message.id !== id) throw new Error(`unexpected response id for ${method}: ${JSON.stringify(message)}`)
  if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`)
  return message.result
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "verify", version: "0.0.0" },
  })
  if (!initialized?.capabilities?.tools) throw new Error("initialize did not advertise tools")

  const listed = await request("tools/list", {})
  const names = new Set((listed.tools ?? []).map((tool) => tool.name))
  for (const name of ["lsp_diagnostics", "lsp_definition", "lsp_hover", "lsp_workspace_symbol"]) {
    if (!names.has(name)) throw new Error(`missing tool ${name}`)
  }

  const symbols = await request("tools/call", {
    name: "lsp_workspace_symbol",
    arguments: { query: "" },
  })
  if (!Array.isArray(symbols?.content)) throw new Error("workspace symbol response is not well formed")
  console.log("PASS mcp round-trip (initialize, tools/list, tools/call)")

  if (!diagnosticsAvailable) {
    console.log("SKIP diagnostics: typescript-language-server not found")
  } else {
    const diagnostics = await request("tools/call", {
      name: "lsp_diagnostics",
      arguments: { file: "src/index.ts", mode: "document" },
    })
    if (diagnostics?.isError) throw new Error(`diagnostics returned error: ${JSON.stringify(diagnostics.structuredContent)}`)
    const structured = diagnostics?.structuredContent?.diagnostics
    const file = path.join(workspace, "src", "index.ts")
    const items = structured?.[file] ?? []
    const hasError = items.some((item) => item?.severity === 1 || typeof item?.message === "string")
    if (!hasError) {
      throw new Error(`expected at least one TypeScript diagnostic for ${file}; got ${JSON.stringify(items)}`)
    }
    console.log("PASS diagnostics (intentional type error surfaced)")
  }
} finally {
  child.kill("SIGTERM")
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

if (stderr && process.env.DEBUG_LSP_VERIFY) process.stderr.write(stderr)
NODE

echo "PASS lsp-sidecar verify"
