import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function assertConfinedRoot(root: string, base: string): string {
  const basePath = resolve(base);
  const rootPath = resolve(root);
  if (!isPathInsideOrSame(rootPath, basePath)) {
    throw new Error(`project-owned root escapes project: ${rootPath}`);
  }
  assertNoSymlinkComponents(rootPath, basePath);
  const baseReal = realpathOrLogical(basePath);
  const rootReal = existsSync(rootPath) ? realpathSync(rootPath) : rootPath;
  if (existsSync(rootPath) && !isPathInsideOrSame(rootReal, baseReal)) {
    throw new Error(`project-owned root resolves outside project: ${rootPath}`);
  }
  return rootPath;
}

export function isConfinedPath(candidate: string, root: string): boolean {
  const rootReal = realpathOrLogical(resolve(root));
  const logicalCandidate = resolve(candidate);
  const candidatePath = existsSync(logicalCandidate) ? realpathSync(logicalCandidate) : logicalCandidate;
  return isPathInsideOrSame(candidatePath, rootReal) || isPathInsideOrSame(candidatePath, resolve(root));
}

function assertNoSymlinkComponents(rootPath: string, basePath: string): void {
  let current = basePath;
  const rel = relative(basePath, rootPath);
  if (!rel || rel === ".") return;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`project-owned root escapes project: ${rootPath}`);
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`project-owned root contains symlink component: ${current}`);
    }
  }
}

function realpathOrLogical(path: string): string {
  let current = path;
  for (;;) {
    if (existsSync(current)) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current) return path;
    current = parent;
  }
}

function isPathInsideOrSame(candidate: string, base: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
