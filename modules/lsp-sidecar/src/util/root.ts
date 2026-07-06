// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/util/filesystem.ts
import fs from "node:fs/promises"
import path from "node:path"

export async function exists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

export async function readText(target: string) {
  return fs.readFile(target, "utf8")
}

export async function findUp(options: { targets: string[]; start: string; stop?: string }) {
  const stop = options.stop ? path.resolve(options.stop) : undefined
  let current = path.resolve(options.start)
  while (true) {
    for (const target of options.targets) {
      const search = path.join(current, target)
      if (await exists(search)) return search
    }
    if (stop === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}
