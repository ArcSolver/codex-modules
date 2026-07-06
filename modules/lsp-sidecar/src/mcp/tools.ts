// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/tool/lsp.ts
import { pathToFileURL } from "node:url"
import { LspInputError, LspServerUnavailableError, type LspSidecarService } from "../lsp/service.js"
import { uriToFilePath } from "../util/path.js"

type JsonSchema = Record<string, unknown>

export type McpTool = {
  name: string
  description: string
  inputSchema: JsonSchema
}

export type ToolResult = {
  content: { type: "text"; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const fileDescription = "Absolute path or path relative to the MCP server root."

export const TOOL_SCHEMAS = {
  lsp_diagnostics: {
    type: "object",
    additionalProperties: false,
    properties: {
      file: {
        type: "string",
        description: fileDescription,
      },
      mode: {
        type: "string",
        enum: ["document", "full"],
        default: "document",
        description:
          "document waits for current-file diagnostics; full also asks workspace/pull diagnostics when supported.",
      },
    },
    required: ["file"],
  },
  lsp_definition: {
    type: "object",
    additionalProperties: false,
    properties: {
      file: { type: "string", description: fileDescription },
      line: {
        type: "integer",
        minimum: 1,
        description: "1-based editor line.",
      },
      character: {
        type: "integer",
        minimum: 1,
        description: "1-based editor character offset.",
      },
    },
    required: ["file", "line", "character"],
  },
  lsp_hover: {
    type: "object",
    additionalProperties: false,
    properties: {
      file: { type: "string", description: fileDescription },
      line: { type: "integer", minimum: 1, description: "1-based editor line." },
      character: { type: "integer", minimum: 1, description: "1-based editor character offset." },
    },
    required: ["file", "line", "character"],
  },
  lsp_workspace_symbol: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        default: "",
        description: "Search query. Empty string asks the server for broad symbols.",
      },
    },
  },
} satisfies Record<string, JsonSchema>

export const TOOLS: McpTool[] = [
  {
    name: "lsp_diagnostics",
    description: "Open or refresh a file and return LSP diagnostics. Coordinates in diagnostics are raw LSP ranges.",
    inputSchema: TOOL_SCHEMAS.lsp_diagnostics,
  },
  {
    name: "lsp_definition",
    description: "Return definition locations for a file position. Input line and character are 1-based.",
    inputSchema: TOOL_SCHEMAS.lsp_definition,
  },
  {
    name: "lsp_hover",
    description: "Return hover information for a file position. Input line and character are 1-based.",
    inputSchema: TOOL_SCHEMAS.lsp_hover,
  },
  {
    name: "lsp_workspace_symbol",
    description: "Search workspace symbols through active LSP clients, warming a root TypeScript client when available.",
    inputSchema: TOOL_SCHEMAS.lsp_workspace_symbol,
  },
]

function asRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LspInputError("arguments must be an object")
  return input as Record<string, unknown>
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string) {
  const value = args[name] ?? fallback
  if (typeof value !== "string") throw new LspInputError(`${name} must be a string`)
  return value
}

function integerArg(args: Record<string, unknown>, name: string) {
  const value = args[name]
  if (!Number.isInteger(value) || Number(value) < 1) throw new LspInputError(`${name} must be an integer >= 1`)
  return Number(value)
}

function normalizeUris(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeUris(item))
  if (!value || typeof value !== "object") return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(input)) output[key] = normalizeUris(item)
  if (typeof input.uri === "string") {
    const file = uriToFilePath(input.uri)
    if (file) output.file = file
  }
  if (!input.uri && typeof input.file === "string") output.uri = pathToFileURL(input.file).href
  return output
}

function textResult(title: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: `${title}\n${JSON.stringify(structuredContent, null, 2)}` }],
    structuredContent,
  }
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof LspServerUnavailableError) {
    return {
      isError: true,
      content: [{ type: "text", text: `${error.message}\n${JSON.stringify({ code: error.code, ...error.details }, null, 2)}` }],
      structuredContent: {
        code: error.code,
        message: error.message,
        ...error.details,
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof LspInputError ? error.code : "LSP_TOOL_ERROR"
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message },
  }
}

export async function callTool(service: LspSidecarService, name: string, rawArguments: unknown): Promise<ToolResult> {
  try {
    const args = asRecord(rawArguments ?? {})
    switch (name) {
      case "lsp_diagnostics": {
        const file = stringArg(args, "file")
        const modeValue = args.mode ?? "document"
        if (modeValue !== "document" && modeValue !== "full") throw new LspInputError("mode must be document or full")
        await service.touchFile(file, modeValue)
        const diagnostics = normalizeUris(await service.diagnostics(file))
        return textResult("lsp_diagnostics", { diagnostics })
      }
      case "lsp_definition": {
        const file = stringArg(args, "file")
        const line = integerArg(args, "line")
        const character = integerArg(args, "character")
        await service.touchFile(file, "document")
        const definitions = normalizeUris(await service.definition({ file, line: line - 1, character: character - 1 }))
        return textResult("lsp_definition", { definitions })
      }
      case "lsp_hover": {
        const file = stringArg(args, "file")
        const line = integerArg(args, "line")
        const character = integerArg(args, "character")
        await service.touchFile(file, "document")
        const hovers = normalizeUris(await service.hover({ file, line: line - 1, character: character - 1 }))
        return textResult("lsp_hover", { hovers })
      }
      case "lsp_workspace_symbol": {
        const query = stringArg(args, "query", "")
        const symbols = normalizeUris(await service.workspaceSymbol(query))
        return textResult("lsp_workspace_symbol", { symbols })
      }
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          structuredContent: { code: "UNKNOWN_TOOL", message: `Unknown tool: ${name}` },
        }
    }
  } catch (error) {
    return errorResult(error)
  }
}
