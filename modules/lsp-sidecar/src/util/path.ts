import path from "node:path"
import { fileURLToPath } from "node:url"

export function normalizePath(input: string) {
  return path.resolve(input)
}

export function isInside(root: string, target: string) {
  const resolvedRoot = normalizePath(root)
  const resolvedTarget = normalizePath(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function resolveFile(root: string, file: string) {
  const resolved = file.startsWith("file://") ? fileURLToPath(file) : path.isAbsolute(file) ? file : path.join(root, file)
  return normalizePath(resolved)
}

export function uriToFilePath(uri: string) {
  if (!uri.startsWith("file://")) return undefined
  return normalizePath(fileURLToPath(uri))
}

export function toDisplayPath(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith("..") ? relative : file
}
