import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FinishStatus, JournalEntry, JournalKind, StateFile, TaskRecord, TasksFile } from "./types.js";
import { TEAM_NAME_RE, MEMBER_NAME_RE } from "./team.js";
import { withLock } from "./lock.js";
import { assertConfinedRoot } from "./paths.js";

export type StateOptions = {
  cwd?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export function resolveStateRoot(opts: StateOptions = {}): string {
  const envRoot = opts.env?.CODEX_TEAMS_STATE_DIR;
  if (opts.stateDir) return resolve(opts.stateDir);
  if (envRoot) return resolve(envRoot);
  const projectRoot = resolve(opts.cwd ?? process.cwd());
  return assertConfinedRoot(join(projectRoot, ".codex-teams"), projectRoot);
}

export function teamDir(team: string, opts: StateOptions = {}): string {
  assertTeamName(team);
  return join(resolveStateRoot(opts), team);
}

export function initState(team: string, goal: string, opts: StateOptions & { noGitignore?: boolean } = {}): StateFile {
  assertTeamName(team);
  const dir = teamDir(team, opts);
  mkdirSync(join(dir, "locks"), { recursive: true });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "runs"), { recursive: true });
  if (!opts.noGitignore && isInsideGitWorktree(opts.cwd ?? process.cwd())) {
    mkdirSync(resolveStateRoot(opts), { recursive: true });
    const gitignore = join(resolveStateRoot(opts), ".gitignore");
    if (!existsSync(gitignore)) writeFileAtomic(gitignore, "*\n");
  }
  return withTeamLock(team, opts, () => {
    const now = nowIso(opts.env);
    const state: StateFile = {
      version: 1,
      team,
      goal,
      status: "active",
      members: {},
      created_at: now,
    };
    writeJsonAtomic(join(dir, "state.json"), state);
    if (!existsSync(join(dir, "tasks.json"))) writeJsonAtomic(join(dir, "tasks.json"), { version: 1, tasks: [] } satisfies TasksFile);
    if (!existsSync(join(dir, "journal.jsonl"))) writeFileAtomic(join(dir, "journal.jsonl"), "");
    return state;
  });
}

export function showState(team: string, opts: StateOptions = {}): StateFile {
  return readJson<StateFile>(join(teamDir(team, opts), "state.json"));
}

export function finishState(team: string, status: FinishStatus, opts: StateOptions = {}): StateFile {
  if (status !== "ok" && status !== "partial") throw new Error("status must be ok or partial");
  return withTeamLock(team, opts, () => {
    const path = join(teamDir(team, opts), "state.json");
    const state = readJson<StateFile>(path);
    state.status = "finished";
    state.finish_status = status;
    state.finished_at = nowIso(opts.env);
    writeJsonAtomic(path, state);
    return state;
  });
}

export function bindMember(
  team: string,
  member: string,
  agentId: string,
  opts: StateOptions & { nickname?: string } = {},
): StateFile {
  assertTeamName(team);
  assertMemberName(member);
  if (!agentId.trim()) throw new Error("agent-id is required");
  return withTeamLock(team, opts, () => {
    const path = join(teamDir(team, opts), "state.json");
    const state = readJson<StateFile>(path);
    state.members[member] = {
      agent_id: agentId,
      nickname: opts.nickname,
      bound_at: nowIso(opts.env),
    };
    writeJsonAtomic(path, state);
    return state;
  });
}

export function addTask(
  team: string,
  input: { title: string; detail?: string; dependsOn?: string[] },
  opts: StateOptions = {},
): TaskRecord {
  if (!input.title.trim()) throw new Error("task title is required");
  return withTaskMutation(team, opts, tasks => {
    const now = nowIso(opts.env);
    const task: TaskRecord = {
      id: nextTaskId(tasks),
      title: input.title,
      detail: input.detail,
      depends_on: input.dependsOn ?? [],
      status: "open",
      created_at: now,
      updated_at: now,
    };
    for (const dep of task.depends_on) {
      if (!tasks.tasks.some(existing => existing.id === dep)) throw new Error(`unknown dependency: ${dep}`);
    }
    tasks.tasks.push(task);
    return task;
  });
}

export function claimTask(
  team: string,
  taskId: string,
  input: { actor: string; leaseSec?: number; reclaim?: boolean },
  opts: StateOptions = {},
): TaskRecord {
  assertMemberName(input.actor);
  const leaseSec = input.leaseSec ?? 900;
  if (!Number.isFinite(leaseSec) || leaseSec <= 0) throw new Error("lease-sec must be > 0");
  return withTaskMutation(team, opts, tasks => {
    reclaimExpired(tasks, nowIso(opts.env));
    const task = mustFindTask(tasks, taskId);
    if (task.status !== "open") throw new Error(`task ${taskId} is not open`);
    const incomplete = task.depends_on.filter(dep => mustFindTask(tasks, dep).status !== "done");
    if (incomplete.length > 0) throw new Error(`task ${taskId} has incomplete dependencies: ${incomplete.join(",")}`);
    const nowMs = Date.parse(nowIso(opts.env));
    task.status = "claimed";
    task.claimed_by = input.actor;
    task.lease_expires_at = new Date(nowMs + leaseSec * 1000).toISOString();
    task.updated_at = new Date(nowMs).toISOString();
    return task;
  });
}

export function completeTask(
  team: string,
  taskId: string,
  input: { actor: string; result?: string; failed?: boolean },
  opts: StateOptions = {},
): TaskRecord {
  assertMemberName(input.actor);
  return withTaskMutation(team, opts, tasks => {
    const task = mustFindTask(tasks, taskId);
    if (task.status !== "claimed" || task.claimed_by !== input.actor) {
      throw new Error(`task ${taskId} is not claimed by ${input.actor}`);
    }
    task.status = input.failed ? "failed" : "done";
    task.result = input.result;
    task.lease_expires_at = undefined;
    task.updated_at = nowIso(opts.env);
    return task;
  });
}

export function listTasks(team: string, opts: StateOptions & { reclaim?: boolean } = {}): TasksFile {
  if (!opts.reclaim) return loadTasks(team, opts);
  return withTaskMutation(team, opts, tasks => {
    reclaimExpired(tasks, nowIso(opts.env));
    return tasks;
  });
}

export function addNote(
  team: string,
  input: { actor: string; text: string; kind?: JournalKind },
  opts: StateOptions = {},
): JournalEntry {
  assertMemberName(input.actor);
  if (!input.text.trim()) throw new Error("note text is required");
  const kind = input.kind ?? "note";
  if (kind !== "note" && kind !== "handoff" && kind !== "decision") throw new Error("kind must be note, handoff, or decision");
  return withTeamLock(team, opts, () => {
    const entry: JournalEntry = { ts: nowIso(opts.env), actor: input.actor, kind, text: input.text };
    appendFileSync(join(teamDir(team, opts), "journal.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  });
}

export function listNotes(team: string, opts: StateOptions = {}): JournalEntry[] {
  const path = join(teamDir(team, opts), "journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as JournalEntry);
}

export function loadTasks(team: string, opts: StateOptions = {}): TasksFile {
  const path = join(teamDir(team, opts), "tasks.json");
  if (!existsSync(path)) return { version: 1, tasks: [] };
  return readJson<TasksFile>(path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeFileAtomic(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function nowIso(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const override = env.CODEX_TEAMS_NOW;
  if (override) {
    const ms = Date.parse(override);
    if (Number.isNaN(ms)) throw new Error(`CODEX_TEAMS_NOW is not a valid ISO timestamp: ${override}`);
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

function withTaskMutation<T>(team: string, opts: StateOptions, fn: (tasks: TasksFile) => T): T {
  return withTeamLock(team, opts, () => {
    const tasks = loadTasks(team, opts);
    const result = fn(tasks);
    writeJsonAtomic(join(teamDir(team, opts), "tasks.json"), tasks);
    return result;
  });
}

function withTeamLock<T>(team: string, opts: StateOptions, fn: () => T): T {
  const dir = teamDir(team, opts);
  mkdirSync(join(dir, "locks"), { recursive: true });
  return withLock(join(dir, "locks", "state.lock"), { ttlMs: 30_000, waitMs: 10_000, purpose: `teams:${team}` }, fn);
}

function reclaimExpired(tasks: TasksFile, now: string): void {
  const nowMs = Date.parse(now);
  for (const task of tasks.tasks) {
    if (task.status === "claimed" && task.lease_expires_at && Date.parse(task.lease_expires_at) <= nowMs) {
      task.status = "open";
      task.claimed_by = undefined;
      task.lease_expires_at = undefined;
      task.updated_at = now;
    }
  }
}

function mustFindTask(tasks: TasksFile, taskId: string): TaskRecord {
  const task = tasks.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}

function nextTaskId(tasks: TasksFile): string {
  let n = tasks.tasks.length + 1;
  for (;;) {
    const id = `task-${String(n).padStart(3, "0")}`;
    if (!tasks.tasks.some(task => task.id === id)) return id;
    n++;
  }
}

function assertTeamName(team: string): void {
  if (!TEAM_NAME_RE.test(team)) throw new Error(`invalid team name: ${team}`);
}

function assertMemberName(member: string): void {
  if (!MEMBER_NAME_RE.test(member)) throw new Error(`invalid member name: ${member}`);
}

function isInsideGitWorktree(cwd: string): boolean {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const next = dirname(current);
    if (next === current) return false;
    current = next;
  }
}
