#!/usr/bin/env node
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import { createAdapterServer } from "../dist/index.js";
import { createFakeClaudeBackend } from "./fake-claude-backend.mjs";

const tracePath = process.env.FAKE_CLAUDE_TRACE ?? "";
const host = process.env.FAKE_CLAUDE_HOST ?? "127.0.0.1";
const adapterHost = process.env.FAKE_CLAUDE_ADAPTER_HOST ?? "127.0.0.1";
const model = process.env.FAKE_CLAUDE_MODEL ?? "with-claude";

function trace(type, payload = {}) {
  if (!tracePath) return;
  fs.appendFileSync(
    tracePath,
    `${JSON.stringify({ type, at: new Date().toISOString(), ...payload })}\n`
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonMaybe(buffer) {
  if (!buffer.length) return undefined;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return undefined;
  }
}

function listen(server, requestedHost) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, requestedHost, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function makeProxy(targetBaseUrl) {
  const target = new URL(targetBaseUrl);
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const bodyJson = parseJsonMaybe(body);
    trace("adapter_request", {
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: bodyJson,
      bodyLength: body.length
    });

    const headers = { ...req.headers };
    headers.host = target.host;
    headers["content-length"] = String(body.length);
    const forwardPath = req.url === "/v1/healthz" ? "/healthz" : req.url;

    const forward = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: forwardPath,
        headers
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, upstream.headers);
        upstream.pipe(res);
      }
    );

    forward.on("error", (error) => {
      trace("proxy_error", { message: error.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
    });
    forward.end(body);
  });
  return server;
}

const backend = createFakeClaudeBackend({ tracePath });
const adapter = await createAdapterServer({
  host: adapterHost,
  port: 0,
  model,
  backend
});

const proxy = makeProxy(adapter.baseUrl);
const proxyAddress = await listen(proxy, host);
const baseUrl = `http://${proxyAddress.address}:${proxyAddress.port}/v1`;
trace("fake_server_started", { baseUrl, adapterBaseUrl: adapter.baseUrl });
console.log(JSON.stringify({ baseUrl, providerId: "with_claude", adapterBaseUrl: adapter.baseUrl }));

let closing = false;
async function closeAndExit(code) {
  if (closing) return;
  closing = true;
  proxy.close();
  await adapter.close();
  trace("fake_server_stopped", { code });
  process.exit(code);
}

process.on("SIGTERM", () => void closeAndExit(0));
process.on("SIGINT", () => void closeAndExit(0));
process.on("uncaughtException", (error) => {
  trace("fake_server_uncaught", { message: error.message, stack: error.stack });
  console.error(error.stack || error.message);
  void closeAndExit(1);
});

await once(proxy, "close");
