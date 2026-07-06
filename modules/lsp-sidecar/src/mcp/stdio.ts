import type { Readable, Writable } from "node:stream"
import { createLspSidecarService, type LspSidecarOptions, type LspSidecarService } from "../lsp/service.js"
import { callTool, TOOLS } from "./tools.js"
import { encodeMessage, JsonRpcFramer, negotiateProtocolVersion, type JsonRpcMessage } from "./protocol.js"

const SERVER_VERSION = "0.1.0"

export type McpServerOptions = LspSidecarOptions & {
  service?: LspSidecarService
}

export function createMcpServer(options: McpServerOptions = {}) {
  const service = options.service ?? createLspSidecarService(options)
  return {
    service,
    async handleRequest(message: JsonRpcMessage): Promise<JsonRpcMessage | undefined> {
      if (!message.method) return undefined
      if (message.id === undefined) return undefined

      switch (message.method) {
        case "initialize": {
          const params = (message.params ?? {}) as { protocolVersion?: unknown }
          return {
            id: message.id,
            result: {
              protocolVersion: negotiateProtocolVersion(params.protocolVersion),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "codex-lsp-sidecar", version: SERVER_VERSION },
            },
          }
        }
        case "tools/list":
          return {
            id: message.id,
            result: { tools: TOOLS },
          }
        case "tools/call": {
          const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown }
          if (typeof params.name !== "string") {
            return {
              id: message.id,
              result: {
                isError: true,
                content: [{ type: "text", text: "tools/call requires a string name" }],
                structuredContent: { code: "INVALID_TOOL_CALL", message: "tools/call requires a string name" },
              },
            }
          }
          return {
            id: message.id,
            result: await callTool(service, params.name, params.arguments),
          }
        }
        default:
          return {
            id: message.id,
            error: { code: -32601, message: `Method not found: ${message.method}` },
          }
      }
    },
    async shutdown() {
      await service.shutdown()
    },
  }
}

export function serveStdio(options: McpServerOptions = {}) {
  const input = options.service ? process.stdin : process.stdin
  const output = process.stdout
  const server = createMcpServer(options)
  wireStdio(server, input, output)
  return server
}

export function wireStdio(
  server: ReturnType<typeof createMcpServer>,
  input: Readable,
  output: Writable,
) {
  const framer = new JsonRpcFramer()
  input.on("data", (chunk) => {
    let messages: JsonRpcMessage[]
    try {
      messages = framer.push(chunk)
    } catch (error) {
      process.stderr.write(`MCP parse error: ${error instanceof Error ? error.message : String(error)}\n`)
      return
    }
    for (const message of messages) {
      void server
        .handleRequest(message)
        .then((response) => {
          if (response) output.write(encodeMessage(response))
        })
        .catch((error) => {
          if (message.id === undefined) return
          output.write(
            encodeMessage({
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          )
        })
    }
  })
  input.on("end", () => {
    void server.shutdown()
  })
  const stop = () => {
    void server.shutdown().finally(() => process.exit(0))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}
