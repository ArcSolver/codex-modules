export type Schedule =
  | { kind: "once"; runAt: string; timezone: "local" }
  | { kind: "interval"; minutes: number }
  | { kind: "cron"; expr: string; timezone: "local" };

export type CodexSandbox = "read-only" | "workspace-write";
export type OutputStatus = "ok" | "error" | "skipped" | "timeout" | "stall" | "dry-run";
export type JobState = "scheduled" | "paused" | "running" | "completed" | "error";

export type RepeatConfig = {
  times: number | null;
  completed: number;
};

export type ScriptConfig = {
  path: string;
  noAgent: boolean;
  timeoutSec: number;
  wakeGate: boolean;
};

export type CodexConfig = {
  enabled: boolean;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  sandbox: CodexSandbox;
  ephemeral: true;
  skipGitRepoCheck: true;
};

export type Claim = {
  runId: string;
  claimedAt: string;
  expiresAt: string;
  pid: number;
  host: string;
};

export type OutputRef = {
  runId: string;
  manual: boolean;
  startedAt: string;
  finishedAt: string;
  status: OutputStatus;
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
  scriptStdoutPath?: string;
  scriptStderrPath?: string;
  error?: string | null;
};

export type JobRecord = {
  id: string;
  name: string;
  enabled: boolean;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  scheduleInput: string;
  scheduleDisplay: string;
  schedule: Schedule;
  nextRunAt: string | null;
  repeat: RepeatConfig;
  cwd: string | null;
  script: ScriptConfig | null;
  codex: CodexConfig;
  claim: Claim | null;
  lastRunAt: string | null;
  lastStatus: OutputStatus | null;
  lastError: string | null;
  lastOutput: OutputRef | null;
  outputs: OutputRef[];
  outputKeep?: number;
};

export type JobStoreFile = {
  version: 1;
  jobs: JobRecord[];
};

export type CreateJobInput = {
  name?: string;
  scheduleInput: string;
  prompt?: string | null;
  cwd?: string | null;
  scriptPath?: string | null;
  noAgent?: boolean;
  repeat?: number | null;
  codex?: Partial<Omit<CodexConfig, "ephemeral" | "skipGitRepoCheck">>;
};

export type StoreOptions = {
  storeDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type RunOptions = StoreOptions & {
  execute?: boolean;
  allowCodex?: boolean;
  timeoutSec?: number;
  stallSec?: number;
  now?: string | Date;
  manual?: boolean;
  bin?: string;
  codexHome?: string;
};

export type TickOptions = RunOptions & {
  limit?: number;
};

export type RemoveOptions = StoreOptions & {
  deleteOutputs?: boolean;
};

export type SchedulerBlueprintSlot = {
  name: string;
  type: "text" | "time" | "enum" | "path";
  label: string;
  required?: boolean;
  default?: string;
  options?: string[];
  help?: string;
};

export type SchedulerBlueprint = {
  key: string;
  title: string;
  description: string;
  slots: SchedulerBlueprintSlot[];
};

export type InstallTickOptions = StoreOptions & {
  platform?: "auto" | "darwin" | "linux";
  intervalMin?: number;
  execute?: boolean;
  allowCodex?: boolean;
  write?: boolean;
  load?: boolean;
  remove?: boolean;
  binPath?: string;
};

export type InstallTickPlan = {
  platform: "darwin" | "linux";
  action: "install" | "remove";
  write: boolean;
  files: { path: string; content?: string; remove?: boolean }[];
  commands: string[][];
};
