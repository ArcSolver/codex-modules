import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveStoreDir } from "./paths.js";
import { type InstallTickOptions, type InstallTickPlan } from "./types.js";

const LABEL = "com.codex-modules.scheduler";
const CRON_BEGIN = "# BEGIN codex-modules scheduler";
const CRON_END = "# END codex-modules scheduler";

export function installTick(options: InstallTickOptions = {}): InstallTickPlan {
  const plan = renderInstallTickPlan(options);
  if (!options.write) return plan;
  if (plan.action === "remove") {
    removeTick(options);
    return plan;
  }
  for (const file of plan.files) {
    if (!file.content) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  if (options.load && plan.platform === "darwin") {
    for (const command of plan.commands) spawnSync(command[0]!, command.slice(1), { stdio: "ignore" });
  }
  if (plan.platform === "linux") installUserCrontab(plan.files[0]?.content ?? "", resolveStoreDir(options));
  return plan;
}

export function removeTick(options: InstallTickOptions = {}): InstallTickPlan {
  const plan = renderInstallTickPlan({ ...options, remove: true });
  if (!options.write) return plan;
  if (plan.platform === "darwin") {
    if (options.load) spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}`, LABEL], { stdio: "ignore" });
    for (const file of plan.files) rmSync(file.path, { force: true });
  } else {
    removeUserCrontab(resolveStoreDir(options));
  }
  return plan;
}

export function renderInstallTickPlan(options: InstallTickOptions = {}): InstallTickPlan {
  const platform = resolvePlatform(options.platform);
  const storeDir = resolveStoreDir(options);
  const interval = options.intervalMin ?? 5;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("--interval-min must be a positive integer");
  const args = ["tick", "--store-dir", storeDir];
  if (options.execute) args.push("--execute");
  if (options.allowCodex) args.push("--allow-codex");
  const command = [options.binPath ?? "codex-scheduler", ...args];
  if (platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    return {
      platform,
      action: options.remove ? "remove" : "install",
      write: !!options.write,
      files: options.remove ? [{ path: plist, remove: true }] : [{ path: plist, content: renderLaunchdPlist(command, interval) }],
      commands: options.remove
        ? [["launchctl", "bootout", `gui/${process.getuid?.() ?? ""}`, LABEL]]
        : [["launchctl", "bootstrap", `gui/${process.getuid?.() ?? ""}`, plist], ["launchctl", "enable", `gui/${process.getuid?.() ?? ""}/${LABEL}`]],
    };
  }
  const cronPath = join(storeDir, "install", "crontab.managed.txt");
  return {
    platform,
    action: options.remove ? "remove" : "install",
    write: !!options.write,
    files: options.remove ? [{ path: cronPath, remove: true }] : [{ path: cronPath, content: renderCronLine(command, interval) }],
    commands: options.remove ? [["crontab", "-"]] : [["crontab", "-"]],
  };
}

export function renderLaunchdPlist(command: string[], intervalMin: number): string {
  const escaped = command.map(item => `<string>${xmlEscape(item)}</string>`).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${escaped}
  </array>
  <key>StartInterval</key><integer>${intervalMin * 60}</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

export function renderCronLine(command: string[], intervalMin: number): string {
  return `${CRON_BEGIN}\n*/${intervalMin} * * * * ${command.map(shellQuote).join(" ")}\n${CRON_END}\n`;
}

function installUserCrontab(managed: string, storeDir: string): void {
  const existing = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const text = existing.status === 0 ? existing.stdout : "";
  const backupDir = join(storeDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, `crontab.${Date.now()}.bak`), text);
  const next = replaceManagedBlock(text, managed);
  const child = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || "crontab install failed");
}

function removeUserCrontab(storeDir: string): void {
  const existing = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (existing.status !== 0) return;
  const backupDir = join(storeDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, `crontab.${Date.now()}.bak`), existing.stdout);
  const next = replaceManagedBlock(existing.stdout, "");
  const child = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || "crontab remove failed");
}

function replaceManagedBlock(text: string, block: string): string {
  const re = new RegExp(`${escapeRe(CRON_BEGIN)}[\\s\\S]*?${escapeRe(CRON_END)}\\n?`, "m");
  const stripped = text.replace(re, "").trimEnd();
  return `${stripped}${stripped ? "\n" : ""}${block}`.trimEnd() + "\n";
}

function resolvePlatform(value: InstallTickOptions["platform"]): "darwin" | "linux" {
  const platform = value === "auto" || value === undefined ? process.platform : value;
  if (platform !== "darwin" && platform !== "linux") throw new Error("install-tick supports user-level launchd on darwin and user crontab on linux only");
  return platform;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
