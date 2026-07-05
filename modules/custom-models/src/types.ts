export type CustomModelSpec = {
  slug: string;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  inputModalities?: string[];
  reasoningEfforts?: string[];
  priority?: number;
};

export type RegisterOptions = {
  codexHome?: string;
  stateDir?: string;
  providerId: string;
  providerName?: string;
  baseUrl: string;
  models: CustomModelSpec[];
  catalogPath?: string;
  profileName?: string;
  requiresOpenaiAuth?: boolean;
  envHttpHeaders?: Record<string, string>;
  setDefaultProvider?: boolean;
  dryRun?: boolean;
  force?: boolean;
  backup?: boolean;
};

export type PlanConflict = {
  code: string;
  message: string;
  path?: string;
};

export type Plan = {
  ok: boolean;
  dryRun: boolean;
  codexHome: string;
  stateDir: string;
  configPath: string;
  catalogPath: string;
  cachePath: string;
  providerId: string;
  routedSlugs: string[];
  changes: string[];
  conflicts: PlanConflict[];
};

export type RegisterResult = {
  applied: boolean;
  transactionId?: string;
  plan: Plan;
  added: string[];
  catalogPath: string;
  configPath: string;
  cachePath: string;
};

export type ListResult = {
  codexHome: string;
  statePath: string;
  providers: Array<{
    providerId: string;
    providerName?: string;
    profileName?: string;
    profilePath?: string;
    baseUrl: string;
    catalogPath: string;
    ownedSlugs: string[];
    models: CustomModelSpec[];
    updatedAt: string;
  }>;
};

export type RemoveResult = {
  applied: boolean;
  transactionId?: string;
  providerId: string;
  removed: string[];
  remaining: string[];
  catalogPath?: string;
  configPath: string;
};

export type RollbackResult = {
  transactionId?: string;
  complete: boolean;
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
  missing: boolean;
};

export type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

export type DoctorResult = {
  ok: boolean;
  codexHome: string;
  stateDir: string;
  checks: DoctorCheck[];
};

export type RawEntry = Record<string, unknown>;
export type RawCatalog = { models: RawEntry[]; [key: string]: unknown };
