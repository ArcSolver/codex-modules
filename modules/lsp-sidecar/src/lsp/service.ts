// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/lsp/lsp.ts
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as LSPClient from "./client.js"
import { SERVER_TABLE, Typescript, type DiscoveryResult, type Info as ServerInfo } from "./server-table.js"
import { exists } from "../util/root.js"
import { isInside, normalizePath, resolveFile } from "../util/path.js"

export type DiagnosticMode = "document" | "full"
export type LocationInput = { file: string; line: number; character: number }

export type SymbolResult = {
  name: string
  kind: number
  location?: {
    uri?: string
    range?: LSPClient.Range
  }
  [key: string]: unknown
}

enum SymbolKind {
  Class = 5,
  Method = 6,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  Struct = 23,
}

const symbolKinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const BROKEN_TTL_MS = 30_000

export class LspServerUnavailableError extends Error {
  readonly code = "LSP_SERVER_UNAVAILABLE"

  constructor(
    message: string,
    readonly details: {
      file?: string
      serverIds: string[]
      discoveries: DiscoveryResult[]
    },
  ) {
    super(message)
    this.name = "LspServerUnavailableError"
  }
}

export class LspInputError extends Error {
  readonly code = "LSP_INPUT_ERROR"
}

type State = {
  clients: LSPClient.Info[]
  servers: Record<string, ServerInfo>
  broken: Map<string, { at: number; discovery?: DiscoveryResult }>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
}

export type LspSidecarOptions = {
  root?: string
  enabledServers?: string[]
  idleMs?: number
  log?: (message: string, data?: Record<string, unknown>) => void
}

export class LspSidecarService {
  readonly root: string
  readonly idleMs: number
  private readonly log: NonNullable<LspSidecarOptions["log"]>
  private readonly state: State
  private idleTimer: ReturnType<typeof setInterval> | undefined

  constructor(options: LspSidecarOptions = {}) {
    this.root = normalizePath(options.root ?? process.cwd())
    this.idleMs = options.idleMs ?? 600_000
    this.log = options.log ?? (() => {})
    const enabled = new Set(options.enabledServers ?? Object.keys(SERVER_TABLE))
    this.state = {
      clients: [],
      servers: Object.fromEntries(Object.entries(SERVER_TABLE).filter(([id]) => enabled.has(id))),
      broken: new Map(),
      spawning: new Map(),
    }
    if (this.idleMs > 0) {
      this.idleTimer = setInterval(() => {
        void this.sweepIdle()
      }, Math.min(this.idleMs, 60_000))
      this.idleTimer.unref?.()
    }
  }

  async touchFile(file: string, mode?: DiagnosticMode) {
    const resolved = await this.resolveExistingFile(file)
    const clients = await this.getClients(resolved)
    if (!clients.length) await this.throwUnavailable(resolved)
    await Promise.all(
      clients.map(async (client) => {
        const after = Date.now()
        const version = await client.notify.open({ path: resolved })
        if (!mode) return
        return client.waitForDiagnostics({
          path: resolved,
          version,
          mode,
          after,
        })
      }),
    )
  }

  async diagnostics(file?: string) {
    const resolved = file ? await this.resolveExistingFile(file) : undefined
    const results: Record<string, LSPClient.Diagnostic[]> = {}
    for (const client of this.state.clients) {
      for (const [target, diagnostics] of client.diagnostics.entries()) {
        if (resolved && target !== resolved) continue
        const arr = results[target] ?? []
        arr.push(...diagnostics)
        results[target] = arr
      }
    }
    if (resolved && !results[resolved]) results[resolved] = []
    return results
  }

  async definition(input: LocationInput) {
    const position = await this.resolveLocation(input)
    const results = await this.run(position.file, (client) =>
      client.connection
        .sendRequest<unknown[] | unknown | null>("textDocument/definition", {
          textDocument: { uri: pathToFileURL(position.file).href },
          position: { line: position.line, character: position.character },
        })
        .catch(() => null),
    )
    return results.flatMap((item) => (Array.isArray(item) ? item : item ? [item] : []))
  }

  async hover(input: LocationInput) {
    const position = await this.resolveLocation(input)
    const results = await this.run(position.file, (client) =>
      client.connection
        .sendRequest<unknown | null>("textDocument/hover", {
          textDocument: { uri: pathToFileURL(position.file).href },
          position: { line: position.line, character: position.character },
        })
        .catch(() => null),
    )
    return results.filter(Boolean)
  }

  async workspaceSymbol(query: string) {
    await this.ensureWorkspaceTypescriptClient()
    if (!this.state.clients.length) await this.throwUnavailable()
    const results = await this.runAll((client) =>
      client.connection
        .sendRequest<SymbolResult[] | null>("workspace/symbol", { query })
        .then((result) => (result ?? []).filter((item) => symbolKinds.includes(item.kind)).slice(0, 10))
        .catch(() => [] as SymbolResult[]),
    )
    return results.flat()
  }

  async status(file?: string) {
    const target = file ? await this.resolveExistingFile(file) : undefined
    if (!target) {
      return Promise.all(
        Object.values(this.state.servers).map(async (server) => {
          const root = this.root
          return server.discover(root, this.context())
        }),
      )
    }
    const extension = path.extname(target)
    const results: DiscoveryResult[] = []
    for (const server of Object.values(this.state.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) {
        results.push({ id: server.id, status: "unsupported", detail: `extension ${extension || "(none)"} is unsupported` })
        continue
      }
      const root = await server.root(target, this.context())
      if (!root) {
        results.push({ id: server.id, status: "unsupported", detail: "root markers excluded this file" })
        continue
      }
      results.push(await server.discover(root, this.context()))
    }
    return results
  }

  async shutdown() {
    if (this.idleTimer) clearInterval(this.idleTimer)
    const clients = [...this.state.clients]
    this.state.clients = []
    await Promise.all(clients.map((client) => client.shutdown().catch(() => undefined)))
  }

  private context() {
    return { directory: this.root, worktree: this.root }
  }

  private async resolveExistingFile(file: string) {
    const resolved = resolveFile(this.root, file)
    if (!isInside(this.root, resolved)) throw new LspInputError(`File is outside sidecar root: ${file}`)
    if (!(await exists(resolved))) throw new LspInputError(`File not found: ${resolved}`)
    return resolved
  }

  private async resolveLocation(input: LocationInput) {
    if (!Number.isInteger(input.line) || input.line < 0) throw new LspInputError("line must be a zero-based integer")
    if (!Number.isInteger(input.character) || input.character < 0) {
      throw new LspInputError("character must be a zero-based integer")
    }
    return {
      file: await this.resolveExistingFile(input.file),
      line: input.line,
      character: input.character,
    }
  }

  private async getClients(file: string) {
    if (!isInside(this.root, file)) return []
    const extension = path.extname(file) || file
    const result: LSPClient.Info[] = []
    const discoveries: DiscoveryResult[] = []

    for (const server of Object.values(this.state.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      const root = await server.root(file, this.context())
      if (!root) continue
      const key = `${root}:${server.id}`
      const broken = this.state.broken.get(key)
      if (broken && Date.now() - broken.at < BROKEN_TTL_MS) {
        if (broken.discovery) discoveries.push(broken.discovery)
        continue
      }
      if (broken) this.state.broken.delete(key)

      const match = this.state.clients.find((client) => client.root === root && client.serverID === server.id)
      if (match) {
        match.lastUsedAt = Date.now()
        result.push(match)
        continue
      }

      const inflight = this.state.spawning.get(key)
      if (inflight) {
        const client = await inflight
        if (client) result.push(client)
        continue
      }

      const task = this.schedule(server, root, key)
      this.state.spawning.set(key, task)
      task.finally(() => {
        if (this.state.spawning.get(key) === task) this.state.spawning.delete(key)
      })
      const client = await task
      if (client) result.push(client)
    }

    if (!result.length && discoveries.length) this.log("LSP servers unavailable", { discoveries })
    return result
  }

  private async schedule(server: ServerInfo, root: string, key: string) {
    const discovery = await server.discover(root, this.context())
    if (discovery.status !== "ready") {
      this.state.broken.set(key, { at: Date.now(), discovery })
      return undefined
    }
    const handle = await server.spawn(root, this.context()).catch((error) => {
      this.state.broken.set(key, {
        at: Date.now(),
        discovery: {
          ...discovery,
          status: "missing-binary",
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      return undefined
    })
    if (!handle) {
      this.state.broken.set(key, { at: Date.now(), discovery })
      return undefined
    }
    const client = await LSPClient.create({
      serverID: server.id,
      server: handle,
      root,
      directory: this.root,
    }).catch(async (error) => {
      this.state.broken.set(key, {
        at: Date.now(),
        discovery: {
          ...discovery,
          status: "missing-binary",
          detail: error instanceof Error ? error.message : String(error),
        },
      })
      await handle.process.kill()
      return undefined
    })
    if (!client) return undefined
    const existing = this.state.clients.find((item) => item.root === root && item.serverID === server.id)
    if (existing) {
      await client.shutdown().catch(() => undefined)
      return existing
    }
    this.state.clients.push(client)
    return client
  }

  private async run<T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
    const clients = await this.getClients(file)
    if (!clients.length) await this.throwUnavailable(file)
    return Promise.all(clients.map((client) => fn(client)))
  }

  private async runAll<T>(fn: (client: LSPClient.Info) => Promise<T>) {
    return Promise.all(this.state.clients.map((client) => fn(client)))
  }

  private async ensureWorkspaceTypescriptClient() {
    if (!this.state.servers[Typescript.id]) return
    const root = this.root
    const key = `${root}:${Typescript.id}`
    if (this.state.clients.some((client) => client.root === root && client.serverID === Typescript.id)) return
    const broken = this.state.broken.get(key)
    if (broken && Date.now() - broken.at < BROKEN_TTL_MS) return
    const task = this.schedule(Typescript, root, key)
    this.state.spawning.set(key, task)
    task.finally(() => {
      if (this.state.spawning.get(key) === task) this.state.spawning.delete(key)
    })
    await task
  }

  private async throwUnavailable(file?: string): Promise<never> {
    const discoveries = file ? await this.status(file).catch(() => [] as DiscoveryResult[]) : await this.status()
    const serverIds = discoveries.filter((item) => item.status !== "unsupported").map((item) => item.id)
    throw new LspServerUnavailableError("No LSP server is available for this request.", {
      file,
      serverIds,
      discoveries,
    })
  }

  private async sweepIdle() {
    const now = Date.now()
    const idle = this.state.clients.filter((client) => now - client.lastUsedAt >= this.idleMs)
    if (!idle.length) return
    this.state.clients = this.state.clients.filter((client) => !idle.includes(client))
    await Promise.all(idle.map((client) => client.shutdown().catch(() => undefined)))
  }
}

export function createLspSidecarService(options: LspSidecarOptions = {}) {
  return new LspSidecarService(options)
}
