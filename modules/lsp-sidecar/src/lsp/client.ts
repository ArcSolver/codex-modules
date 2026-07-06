// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/lsp/client.ts
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Writable, Readable } from "node:stream"
import type { Handle } from "./server-table.js"
import { LANGUAGE_EXTENSIONS } from "./language.js"
import { terminateProcess } from "./launch.js"
import { encodeMessage, JsonRpcFramer, type JsonRpcMessage } from "../mcp/protocol.js"
import { normalizePath, uriToFilePath } from "../util/path.js"
import { readText } from "../util/root.js"
import { withTimeout } from "../util/timeout.js"

const DIAGNOSTICS_DEBOUNCE_MS = 150
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000
const INITIALIZE_TIMEOUT_MS = 45_000

const FILE_CHANGE_CREATED = 1
const FILE_CHANGE_CHANGED = 2
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2

export type Position = { line: number; character: number }
export type Range = { start: Position; end: Position }
export type Diagnostic = {
  range: Range
  severity?: number
  code?: string | number
  source?: string
  message: string
  [key: string]: unknown
}

type DocumentDiagnosticReport = {
  items?: Diagnostic[]
  relatedDocuments?: Record<string, DocumentDiagnosticReport>
}

type WorkspaceDiagnosticReport = {
  items?: {
    uri?: string
    items?: Diagnostic[]
  }[]
}

type DiagnosticRequestResult = {
  handled: boolean
  matched: boolean
  byFile: Map<string, Diagnostic[]>
}

type CapabilityRegistration = {
  id: string
  method: string
  registerOptions?: {
    identifier?: string
    workspaceDiagnostics?: boolean
  }
}

type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        change?: number
      }
  diagnosticProvider?: unknown
  [key: string]: unknown
}

type PendingRequest = {
  resolve(value: unknown): void
  reject(error: Error): void
}

class LspJsonRpcConnection {
  private nextId = 1
  private framer = new JsonRpcFramer()
  private pending = new Map<number, PendingRequest>()
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on("data", (chunk) => {
      for (const message of this.framer.push(chunk)) this.handleMessage(message)
    })
    input.on("error", (error) => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    input.on("end", () => {
      const error = new Error("LSP server closed stdout")
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
  }

  onNotification(method: string, handler: (params: unknown) => void) {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
    this.requestHandlers.set(method, handler)
  }

  sendNotification(method: string, params?: unknown) {
    this.output.write(encodeMessage({ method, params }))
  }

  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
    })
    this.output.write(encodeMessage({ id, method, params }))
    return promise
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message)
      return
    }
    if (message.id !== undefined) {
      const id = typeof message.id === "number" ? message.id : Number(message.id)
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params)
    }
  }

  private async handleServerRequest(message: JsonRpcMessage) {
    const handler = this.requestHandlers.get(message.method ?? "")
    if (!handler) {
      this.output.write(
        encodeMessage({
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }),
      )
      return
    }
    try {
      const result = await handler(message.params)
      this.output.write(encodeMessage({ id: message.id, result }))
    } catch (error) {
      this.output.write(
        encodeMessage({
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
    }
  }
}

function getSyncKind(capabilities?: ServerCapabilities) {
  if (!capabilities) return undefined
  const sync = capabilities.textDocumentSync
  if (typeof sync === "number") return sync
  return sync?.change
}

function endPosition(text: string) {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0,
  }
}

function dedupeDiagnostics(items: Diagnostic[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify({
      code: item.code,
      severity: item.severity,
      message: item.message,
      source: item.source,
      range: item.range,
    })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function configurationValue(settings: unknown, section?: string) {
  if (!section) return settings ?? null
  const result = section.split(".").reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
    return (acc as Record<string, unknown>)[key]
  }, settings)
  return result ?? null
}

function shouldSeedDiagnosticsOnFirstPush(serverID: string) {
  return serverID === "typescript"
}

export async function create(input: {
  serverID: string
  server: Handle
  root: string
  directory: string
}) {
  const connection = new LspJsonRpcConnection(input.server.process.stdout, input.server.process.stdin)
  input.server.process.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${input.serverID}] ${chunk}`)
  })

  const pushDiagnostics = new Map<string, Diagnostic[]>()
  const pullDiagnostics = new Map<string, Diagnostic[]>()
  const published = new Map<string, { at: number; version?: number }>()
  const diagnosticRegistrations = new Map<string, CapabilityRegistration>()
  const registrationListeners = new Set<() => void>()
  const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>()
  const mergedDiagnostics = (filePath: string) =>
    dedupeDiagnostics([...(pushDiagnostics.get(filePath) ?? []), ...(pullDiagnostics.get(filePath) ?? [])])
  const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pushDiagnostics.set(filePath, next)
    for (const listener of diagnosticListeners) listener({ path: filePath, serverID: input.serverID })
  }
  const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
    pullDiagnostics.set(filePath, next)
  }
  const emitRegistrationChange = () => {
    for (const listener of [...registrationListeners]) listener()
  }

  connection.onNotification("textDocument/publishDiagnostics", (params) => {
    const payload = params as { uri?: string; diagnostics?: Diagnostic[]; version?: number }
    if (!payload.uri) return
    const filePath = uriToFilePath(payload.uri)
    if (!filePath) return
    published.set(filePath, {
      at: Date.now(),
      version: typeof payload.version === "number" ? payload.version : undefined,
    })
    const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : []
    if (shouldSeedDiagnosticsOnFirstPush(input.serverID) && !pushDiagnostics.has(filePath)) {
      pushDiagnostics.set(filePath, diagnostics)
      return
    }
    updatePushDiagnostics(filePath, diagnostics)
  })
  connection.onRequest("window/workDoneProgress/create", () => null)
  connection.onRequest("workspace/configuration", (params) => {
    const items = (params as { items?: { section?: string }[] }).items ?? []
    return items.map((item) => configurationValue(input.server.initialization, item.section))
  })
  connection.onRequest("client/registerCapability", (params) => {
    const registrations = (params as { registrations?: CapabilityRegistration[] }).registrations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.set(registration.id, registration)
      changed = true
    }
    if (changed) emitRegistrationChange()
    return null
  })
  connection.onRequest("client/unregisterCapability", (params) => {
    const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
    let changed = false
    for (const registration of registrations) {
      if (registration.method !== "textDocument/diagnostic") continue
      diagnosticRegistrations.delete(registration.id)
      changed = true
    }
    if (changed) emitRegistrationChange()
    return null
  })
  connection.onRequest("workspace/workspaceFolders", () => [
    {
      name: "workspace",
      uri: pathToFileURL(input.root).href,
    },
  ])
  connection.onRequest("workspace/diagnostic/refresh", () => null)

  const initialized = await withTimeout(
    connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
      rootUri: pathToFileURL(input.root).href,
      processId: input.server.process.pid,
      workspaceFolders: [
        {
          name: "workspace",
          uri: pathToFileURL(input.root).href,
        },
      ],
      initializationOptions: {
        ...input.server.initialization,
      },
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }),
    INITIALIZE_TIMEOUT_MS,
  ).catch((err) => {
    throw new Error(`LSP initialize failed for ${input.serverID}: ${err instanceof Error ? err.message : String(err)}`)
  })

  const syncKind = getSyncKind(initialized.capabilities)
  const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider)

  connection.sendNotification("initialized", {})
  if (input.server.initialization) {
    connection.sendNotification("workspace/didChangeConfiguration", {
      settings: input.server.initialization,
    })
  }

  const files: Record<string, { version: number; text: string }> = {}

  const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
    const handled = results.some((result) => result.handled)
    const matched = results.some((result) => result.matched)
    if (!handled) return { handled: false, matched: false }

    const merged = new Map<string, Diagnostic[]>()
    for (const result of results) {
      for (const [target, items] of result.byFile.entries()) {
        const existing = merged.get(target) ?? []
        merged.set(target, existing.concat(items))
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, [])
    for (const [target, items] of merged.entries()) {
      updatePullDiagnostics(target, dedupeDiagnostics(items))
    }

    return { handled, matched }
  }

  async function requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: {
          uri: pathToFileURL(filePath).href,
        },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    const push = (target: string, items: Diagnostic[]) => {
      const existing = byFile.get(target) ?? []
      byFile.set(target, existing.concat(items))
    }

    let handled = false
    let matched = false
    if (Array.isArray(report.items)) {
      push(filePath, report.items)
      handled = true
      matched = true
    }
    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = uriToFilePath(uri)
      if (!relatedPath || !Array.isArray(related.items)) continue
      push(relatedPath, related.items)
      handled = true
      matched = matched || relatedPath === filePath
    }

    return { handled, matched, byFile }
  }

  async function requestWorkspaceDiagnosticReport(
    filePath: string,
    identifier?: string,
  ): Promise<DiagnosticRequestResult> {
    const report = await withTimeout(
      connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    ).catch(() => null)
    if (!report) return { handled: false, matched: false, byFile: new Map<string, Diagnostic[]>() }

    const byFile = new Map<string, Diagnostic[]>()
    let matched = false
    for (const item of report.items ?? []) {
      const relatedPath = item.uri ? uriToFilePath(item.uri) : undefined
      if (!relatedPath || !Array.isArray(item.items)) continue
      const existing = byFile.get(relatedPath) ?? []
      byFile.set(relatedPath, existing.concat(item.items))
      matched = matched || relatedPath === filePath
    }

    return { handled: true, matched, byFile }
  }

  function documentPullState() {
    const documentRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics !== true,
    )
    return {
      documentIdentifiers: [
        ...new Set(documentRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
    }
  }

  function workspacePullState() {
    const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
      (registration) => registration.registerOptions?.workspaceDiagnostics === true,
    )
    return {
      workspaceIdentifiers: [
        ...new Set(workspaceRegistrations.flatMap((registration) => registration.registerOptions?.identifier ?? [])),
      ],
      supported: workspaceRegistrations.length > 0,
    }
  }

  const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
    results.some((result) => (result.byFile.get(filePath)?.length ?? 0) > 0)

  async function requestDiagnostics(
    filePath: string,
    requests: Promise<DiagnosticRequestResult>[],
    done: (results: DiagnosticRequestResult[]) => boolean,
  ) {
    if (!requests.length) return { handled: false, matched: false }

    const results: DiagnosticRequestResult[] = []
    return new Promise<{ handled: boolean; matched: boolean }>((resolve) => {
      let pending = requests.length
      let resolved = false
      const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
        if (resolved) return
        if (!force && !done(results)) return
        resolved = true
        resolve(merged)
      }

      for (const request of requests) {
        request.then((result) => {
          results.push(result)
          pending -= 1
          const merged = mergeResults(filePath, results)
          finish(merged)
          if (pending === 0) finish(merged, true)
        })
      }
    })
  }

  async function requestDocumentDiagnostics(filePath: string) {
    const state = documentPullState()
    if (!state.supported) return { handled: false, matched: false }
    return requestDiagnostics(
      filePath,
      [
        requestDiagnosticReport(filePath),
        ...state.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
      ],
      (results) => hasCurrentFileDiagnostics(filePath, results),
    )
  }

  async function requestFullDiagnostics(filePath: string) {
    const documentState = documentPullState()
    const workspaceState = workspacePullState()
    if (!documentState.supported && !workspaceState.supported) return { handled: false, matched: false }
    return mergeResults(
      filePath,
      await Promise.all([
        ...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
        ...documentState.documentIdentifiers.map((identifier) => requestDiagnosticReport(filePath, identifier)),
        ...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
        ...workspaceState.workspaceIdentifiers.map((identifier) =>
          requestWorkspaceDiagnosticReport(filePath, identifier),
        ),
      ]),
    )
  }

  function waitForRegistrationChange(timeout: number) {
    if (timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (timer) clearTimeout(timer)
        registrationListeners.delete(listener)
        resolve(result)
      }
      const listener = () => finish(true)
      registrationListeners.add(listener)
      timer = setTimeout(() => finish(false), timeout)
    })
  }

  function waitForFreshPush(request: { path: string; version: number; after: number; timeout: number }) {
    if (request.timeout <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let finished = false
      let debounceTimer: ReturnType<typeof setTimeout> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        if (debounceTimer) clearTimeout(debounceTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
        unsub?.()
        resolve(result)
      }
      const schedule = () => {
        const hit = published.get(request.path)
        if (!hit) return
        if (typeof hit.version === "number" && hit.version !== request.version) return
        if (hit.at < request.after && hit.version !== request.version) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)))
      }

      timeoutTimer = setTimeout(() => finish(false), request.timeout)
      const listener = (event: { path: string; serverID: string }) => {
        if (event.path !== request.path || event.serverID !== input.serverID) return
        schedule()
      }
      diagnosticListeners.add(listener)
      unsub = () => diagnosticListeners.delete(listener)
      schedule()
    })
  }

  async function waitForDocumentDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
      const result = await requestDocumentDiagnostics(request.path)
      if (result.matched) return
      const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  async function waitForFullDiagnostics(request: { path: string; version: number; after?: number }) {
    const startedAt = request.after ?? Date.now()
    const pushWait = waitForFreshPush({
      path: request.path,
      version: request.version,
      after: startedAt,
      timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
    })

    while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
      const result = await requestFullDiagnostics(request.path)
      if (result.handled || result.matched) return
      const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt)
      if (remaining <= 0) return
      const next = await Promise.race([
        pushWait.then((ready) => (ready ? "push" : ("timeout" as const))),
        waitForRegistrationChange(remaining).then((changed) => (changed ? "registration" : ("timeout" as const))),
      ])
      if (next !== "registration") return
    }
  }

  const result = {
    root: input.root,
    serverID: input.serverID,
    lastUsedAt: Date.now(),
    connection,
    notify: {
      async open(request: { path: string }) {
        request.path = normalizePath(path.isAbsolute(request.path) ? request.path : path.resolve(input.directory, request.path))
        const text = await readText(request.path)
        const extension = path.extname(request.path)
        const languageId = LANGUAGE_EXTENSIONS[extension] ?? "plaintext"

        const document = files[request.path]
        if (document !== undefined) {
          connection.sendNotification("workspace/didChangeWatchedFiles", {
            changes: [
              {
                uri: pathToFileURL(request.path).href,
                type: FILE_CHANGE_CHANGED,
              },
            ],
          })

          const next = document.version + 1
          files[request.path] = { version: next, text }
          connection.sendNotification("textDocument/didChange", {
            textDocument: {
              uri: pathToFileURL(request.path).href,
              version: next,
            },
            contentChanges:
              syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
                ? [
                    {
                      range: {
                        start: { line: 0, character: 0 },
                        end: endPosition(document.text),
                      },
                      text,
                    },
                  ]
                : [{ text }],
          })
          result.lastUsedAt = Date.now()
          return next
        }

        connection.sendNotification("workspace/didChangeWatchedFiles", {
          changes: [
            {
              uri: pathToFileURL(request.path).href,
              type: FILE_CHANGE_CREATED,
            },
          ],
        })

        pushDiagnostics.delete(request.path)
        pullDiagnostics.delete(request.path)
        connection.sendNotification("textDocument/didOpen", {
          textDocument: {
            uri: pathToFileURL(request.path).href,
            languageId,
            version: 0,
            text,
          },
        })
        files[request.path] = { version: 0, text }
        result.lastUsedAt = Date.now()
        return 0
      },
    },
    get diagnostics() {
      const diagnostics = new Map<string, Diagnostic[]>()
      for (const filePath of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
        diagnostics.set(filePath, mergedDiagnostics(filePath))
      }
      return diagnostics
    },
    waitForDiagnostics(request: { path: string; version: number; mode: "document" | "full"; after?: number }) {
      result.lastUsedAt = Date.now()
      if (request.mode === "full") return waitForFullDiagnostics(request)
      return waitForDocumentDiagnostics(request)
    },
    async shutdown() {
      try {
        await withTimeout(connection.sendRequest("shutdown", null), 1_000)
      } catch {
        // best effort
      }
      try {
        connection.sendNotification("exit")
      } catch {
        // best effort
      }
      await terminateProcess(input.server.process)
    },
  }

  return result
}

export type Info = Awaited<ReturnType<typeof create>>
