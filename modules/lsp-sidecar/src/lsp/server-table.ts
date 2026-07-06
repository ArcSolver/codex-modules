// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/lsp/server.ts
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type LspChild } from "./launch.js"
import { exists, findUp } from "../util/root.js"

export interface Handle {
  process: LspChild
  initialization?: Record<string, unknown>
}

export type WorkspaceContext = {
  directory: string
  worktree: string
}

type RootFunction = (file: string, ctx: WorkspaceContext) => Promise<string | undefined>

export type ServerStatus = "ready" | "missing-binary" | "missing-project-package" | "unsupported"

export interface DiscoveryResult {
  id: string
  root?: string
  binary?: string
  projectPackage?: string
  status: ServerStatus
  detail?: string
}

export interface Info {
  id: string
  extensions: string[]
  root: RootFunction
  requiredPackage?: string
  binaryName: string
  discover(root: string, ctx: WorkspaceContext): Promise<DiscoveryResult>
  spawn(root: string, ctx: WorkspaceContext): Promise<Handle | undefined>
}

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const packageLockMarkers = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]
const tsExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

function NearestRoot(includePatterns: string[], excludePatterns?: string[]): RootFunction {
  return async (file, ctx) => {
    if (excludePatterns) {
      const excluded = await findUp({
        targets: excludePatterns,
        start: path.dirname(file),
        stop: ctx.directory,
      })
      if (excluded) return undefined
    }
    const first = await findUp({
      targets: includePatterns,
      start: path.dirname(file),
      stop: ctx.directory,
    })
    if (!first) return ctx.directory
    return path.dirname(first)
  }
}

function candidateBinDirs(root: string, ctx: WorkspaceContext) {
  return [
    path.join(root, "node_modules", ".bin"),
    path.join(ctx.directory, "node_modules", ".bin"),
    path.join(moduleRoot, "node_modules", ".bin"),
  ]
}

async function findBinary(name: string, root: string, ctx: WorkspaceContext) {
  const names = process.platform === "win32" ? [name + ".cmd", name + ".exe", name] : [name]
  for (const dir of candidateBinDirs(root, ctx)) {
    for (const item of names) {
      const candidate = path.join(dir, item)
      if (await exists(candidate)) return candidate
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const item of names) {
      const candidate = path.join(dir, item)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

function resolvePackage(request: string, root: string, ctx: WorkspaceContext) {
  const bases = [root, ctx.directory, moduleRoot]
  for (const base of bases) {
    try {
      return createRequire(path.join(base, "package.json")).resolve(request)
    } catch {
      // try the next base
    }
  }
  return undefined
}

async function executableExists(target: string) {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false)
}

async function discoverCommon(input: {
  id: string
  root: string
  ctx: WorkspaceContext
  binaryName: string
  requiredPackage?: string
}) {
  const binary = await findBinary(input.binaryName, input.root, input.ctx)
  const projectPackage = input.requiredPackage ? resolvePackage(input.requiredPackage, input.root, input.ctx) : undefined
  if (!binary) {
    return {
      id: input.id,
      root: input.root,
      projectPackage,
      status: "missing-binary" as const,
      detail: `${input.binaryName} not found in node_modules/.bin or PATH`,
    }
  }
  if (!(await executableExists(binary))) {
    return {
      id: input.id,
      root: input.root,
      binary,
      projectPackage,
      status: "missing-binary" as const,
      detail: `${binary} is not accessible`,
    }
  }
  if (input.requiredPackage && !projectPackage) {
    return {
      id: input.id,
      root: input.root,
      binary,
      status: "missing-project-package" as const,
      detail: `${input.requiredPackage} is not resolvable`,
    }
  }
  return {
    id: input.id,
    root: input.root,
    binary,
    projectPackage,
    status: "ready" as const,
  }
}

export const Typescript: Info = {
  id: "typescript",
  root: NearestRoot(packageLockMarkers, ["deno.json", "deno.jsonc"]),
  extensions: tsExtensions,
  requiredPackage: "typescript/lib/tsserver.js",
  binaryName: "typescript-language-server",
  discover(root, ctx) {
    return discoverCommon({
      id: this.id,
      root,
      ctx,
      binaryName: this.binaryName,
      requiredPackage: this.requiredPackage,
    })
  },
  async spawn(root, ctx) {
    const discovery = await this.discover(root, ctx)
    if (discovery.status !== "ready" || !discovery.binary || !discovery.projectPackage) return undefined
    return {
      process: spawn(discovery.binary, ["--stdio"], {
        cwd: root,
        env: { ...process.env },
      }),
      initialization: {
        tsserver: {
          path: discovery.projectPackage,
        },
      },
    }
  },
}

export const ESLint: Info = {
  id: "eslint",
  root: NearestRoot(packageLockMarkers),
  extensions: [...tsExtensions, ".vue"],
  requiredPackage: "eslint",
  binaryName: "vscode-eslint-language-server",
  discover(root, ctx) {
    return discoverCommon({
      id: this.id,
      root,
      ctx,
      binaryName: this.binaryName,
      requiredPackage: this.requiredPackage,
    })
  },
  async spawn(root, ctx) {
    const discovery = await this.discover(root, ctx)
    if (discovery.status !== "ready" || !discovery.binary) return undefined
    return {
      process: spawn(discovery.binary, ["--stdio"], {
        cwd: root,
        env: { ...process.env },
      }),
    }
  },
}

export const Biome: Info = {
  id: "biome",
  root: NearestRoot(["biome.json", "biome.jsonc", ...packageLockMarkers]),
  extensions: [...tsExtensions, ".json", ".jsonc", ".vue", ".astro", ".svelte", ".css", ".graphql", ".gql", ".html"],
  binaryName: "biome",
  discover(root, ctx) {
    return discoverCommon({
      id: this.id,
      root,
      ctx,
      binaryName: this.binaryName,
    })
  },
  async spawn(root, ctx) {
    const discovery = await this.discover(root, ctx)
    if (discovery.status !== "ready" || !discovery.binary) return undefined
    return {
      process: spawn(discovery.binary, ["lsp-proxy", "--stdio"], {
        cwd: root,
        env: { ...process.env },
      }),
    }
  },
}

export const SERVER_TABLE: Record<string, Info> = {
  [Typescript.id]: Typescript,
  [ESLint.id]: ESLint,
  [Biome.id]: Biome,
}

export async function discoverForRoot(ctx: WorkspaceContext, file?: string) {
  const results: DiscoveryResult[] = []
  const targetFile = file ?? path.join(ctx.directory, "index.ts")
  for (const server of Object.values(SERVER_TABLE)) {
    const extension = path.extname(targetFile)
    if (file && server.extensions.length && !server.extensions.includes(extension)) {
      results.push({ id: server.id, status: "unsupported", detail: `extension ${extension || "(none)"} is unsupported` })
      continue
    }
    const root = await server.root(targetFile, ctx)
    if (!root) {
      results.push({ id: server.id, status: "unsupported", detail: "root markers excluded this file" })
      continue
    }
    results.push(await server.discover(root, ctx))
  }
  return results
}
