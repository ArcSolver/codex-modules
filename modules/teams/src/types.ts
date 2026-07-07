export type SandboxMode = "read-only" | "workspace-write";
export type MemberLens = "area" | "ownership" | "perspective";
export type InstallScope = "user" | "project";
export type TeamStatus = "active" | "finished";
export type FinishStatus = "ok" | "partial";
export type TaskStatus = "open" | "claimed" | "done" | "failed";
export type JournalKind = "note" | "handoff" | "decision";

export type TeamDefaults = {
  model?: string | null;
  sandbox_mode?: SandboxMode | null;
};

export type MemberDef = {
  name: string;
  focus: string;
  lens: MemberLens;
  deliverable: string;
  model?: string | null;
  sandbox_mode?: SandboxMode | null;
  instructions?: string | null;
};

export type TeamDef = {
  version: 1;
  name: string;
  description?: string;
  defaults?: TeamDefaults;
  members: MemberDef[];
};

export type BoundMember = {
  agent_id: string;
  nickname?: string;
  bound_at: string;
};

export type StateFile = {
  version: 1;
  team: string;
  goal: string;
  status: TeamStatus;
  leader_session?: string;
  members: Record<string, BoundMember>;
  created_at: string;
  finished_at?: string;
  finish_status?: FinishStatus;
};

export type TaskRecord = {
  id: string;
  title: string;
  detail?: string;
  depends_on: string[];
  status: TaskStatus;
  claimed_by?: string;
  lease_expires_at?: string;
  result?: string;
  result_meta?: unknown;
  created_at: string;
  updated_at: string;
};

export type TasksFile = {
  version: 1;
  tasks: TaskRecord[];
};

export type JournalEntry = {
  ts: string;
  actor: string;
  kind: JournalKind;
  text: string;
  task_id?: string;
};

export type ManifestEntry = {
  team: string;
  scope: InstallScope | "skill";
  file: string;
  backup?: string | null;
  hash: string;
  kind: "agent" | "skill";
  member?: string;
  installed_at: string;
};

export type TeamsManifest = {
  version: 1;
  owner: "@codex-modules/teams";
  entries: ManifestEntry[];
};

export type DoctorReport = {
  codexBinary: string | null;
  version: string | null;
  features: Array<{ name: string; stage: string; enabled: boolean }>;
  featuresError?: string;
  multiAgent: { present: boolean; stage?: string; enabled?: boolean };
  fanout?: { present: boolean; stage?: string; enabled?: boolean };
  multiAgentV2?: { present: boolean; stage?: string; enabled?: boolean };
  models: { ok: boolean; values: string[]; error?: string };
  agentsDirWritable: boolean;
  stateDirWritable: boolean;
  userInstalledTeams: string[];
  projectInstalledTeams: string[];
};
