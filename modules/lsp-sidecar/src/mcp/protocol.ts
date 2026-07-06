export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const
export const DEFAULT_PROTOCOL_VERSION = "2025-11-25"

export type JsonRpcId = string | number | null

export type JsonRpcMessage = {
  jsonrpc?: "2.0"
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export function negotiateProtocolVersion(requested: unknown) {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested as never)) return requested
  return DEFAULT_PROTOCOL_VERSION
}

export function encodeMessage(message: JsonRpcMessage) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

export class JsonRpcFramer {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer | string) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    const messages: JsonRpcMessage[] = []
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const lengthLine = header
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("content-length:"))
      if (!lengthLine) throw new Error("Missing Content-Length header")
      const length = Number(lengthLine.slice(lengthLine.indexOf(":") + 1).trim())
      if (!Number.isFinite(length) || length < 0) throw new Error("Invalid Content-Length header")
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + length
      if (this.buffer.length < bodyEnd) break
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")
      this.buffer = this.buffer.subarray(bodyEnd)
      messages.push(JSON.parse(body) as JsonRpcMessage)
    }
    return messages
  }
}
