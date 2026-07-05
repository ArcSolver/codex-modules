export type SandboxMode = "read-only" | "workspace-write";

export type TaskSpec = {
  id: string;
  prompt: string;
  cwd?: string;
  sandbox?: SandboxMode;
  model?: string;
  effort?: string;
  outputSchemaPath?: string;
  configOverrides?: Record<string, string>;
};

export type RunTasksOptions = {
  parallel?: number;
  timeoutSec?: number;
  stallSec?: number;
  outDir: string;
  codexHome?: string;
  bin?: string;
  ephemeral?: boolean;
  resume?: boolean;
};

export type ResolvedRunTasksOptions = {
  parallel: number;
  timeoutSec: number;
  stallSec: number;
  outDir: string;
  codexHome?: string;
  bin: string;
  ephemeral: boolean;
  resume: boolean;
};

export type TaskStatus = "ok" | "stall" | "timeout" | "error";

export type TaskResult = {
  id: string;
  status: TaskStatus;
  exitCode: number | null;
  durationMs: number;
  lastMessagePath: string;
  eventsPath: string;
};

export type BuildArgvOptions = Pick<ResolvedRunTasksOptions, "outDir" | "ephemeral">;

export type NativeFeatureState = {
  name: "multi_agent" | "enable_fanout" | "multi_agent_v2" | "child_agents_md";
  stage: string | null;
  enabled: boolean;
  supported: boolean;
  usable: boolean;
  note: string;
};

export type NativeDetection = {
  bin: string | null;
  features: NativeFeatureState[];
  error?: string;
};

export type DoctorResult = {
  codexBinary: string | null;
  version: string | null;
  native: NativeDetection;
  recommendations: string[];
};
