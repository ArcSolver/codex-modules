#!/usr/bin/env node
import { createLspSidecarService } from "./lsp/service.js"
import { serveStdio } from "./mcp/stdio.js"

type Parsed = {
  command: string
  root: string
  idleMs?: number
  json?: boolean
  jsonLog?: boolean
}

function usage() {
  return `Usage:
  codex-lsp-sidecar serve --root <dir> [--idle-ms <ms>] [--json-log]
  codex-lsp-sidecar doctor --root <dir> [--json]
`
}

function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv
  const parsed: Parsed = { command, root: process.cwd() }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    switch (arg) {
      case "--root": {
        const value = rest[++i]
        if (!value) throw new Error("--root requires a value")
        parsed.root = value
        break
      }
      case "--idle-ms": {
        const value = rest[++i]
        if (!value || !/^\d+$/.test(value)) throw new Error("--idle-ms requires a non-negative integer")
        parsed.idleMs = Number(value)
        break
      }
      case "--json":
        parsed.json = true
        break
      case "--json-log":
        parsed.jsonLog = true
        break
      case "-h":
      case "--help":
        parsed.command = "help"
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function makeLogger(jsonLog: boolean | undefined) {
  return (message: string, data?: Record<string, unknown>) => {
    if (jsonLog) {
      process.stderr.write(JSON.stringify({ level: "info", message, ...data }) + "\n")
      return
    }
    process.stderr.write(data ? `${message} ${JSON.stringify(data)}\n` : `${message}\n`)
  }
}

async function doctor(parsed: Parsed) {
  const service = createLspSidecarService({
    root: parsed.root,
    idleMs: 0,
    log: makeLogger(false),
  })
  try {
    const rows = await service.status()
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ root: service.root, servers: rows }, null, 2) + "\n")
      return
    }
    process.stdout.write(`root: ${service.root}\n`)
    process.stdout.write("server\tstatus\troot\tbinary\tprojectPackage\tdetail\n")
    for (const row of rows) {
      process.stdout.write(
        [
          row.id,
          row.status,
          row.root ?? "",
          row.binary ?? "",
          row.projectPackage ?? "",
          row.detail ?? "",
        ].join("\t") + "\n",
      )
    }
  } finally {
    await service.shutdown()
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  switch (parsed.command) {
    case "serve":
      serveStdio({
        root: parsed.root,
        idleMs: parsed.idleMs,
        log: makeLogger(parsed.jsonLog),
      })
      break
    case "doctor":
      await doctor(parsed)
      break
    case "help":
      process.stdout.write(usage())
      break
    default:
      throw new Error(`Unknown command: ${parsed.command}\n${usage()}`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
