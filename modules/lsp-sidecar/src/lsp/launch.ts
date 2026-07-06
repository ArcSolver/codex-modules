// Adapted from https://github.com/sst/opencode/blob/main/packages/opencode/src/lsp/launch.ts
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"

export type LspChild = ChildProcessWithoutNullStreams

export function spawn(command: string, args: string[] = [], options: SpawnOptions = {}) {
  const proc = nodeSpawn(command, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")
  return proc
}

export async function terminateProcess(child: LspChild, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGTERM")
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        resolve()
      }, timeoutMs)
    }),
  ])
}
