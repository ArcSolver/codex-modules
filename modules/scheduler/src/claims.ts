import { hostname } from "node:os";
import { computeNextRun } from "./schedule.js";
import { toDate, toLocalIso } from "./time.js";
import { safeRunId } from "./paths.js";
import { type Claim, type JobRecord, type JobStoreFile, type OutputRef, type OutputStatus } from "./types.js";

export function findDueJobs(store: JobStoreFile, now: Date): JobRecord[] {
  return store.jobs.filter(job => isDue(job, now));
}

export function claimDueJobs(store: JobStoreFile, opts: { now: Date; limit?: number; allowCodex?: boolean; ttlSec?: number }): { job: JobRecord; claim: Claim }[] {
  clearStaleClaims(store, opts.now);
  const claimed: { job: JobRecord; claim: Claim }[] = [];
  for (const job of store.jobs) {
    if (claimed.length >= (opts.limit ?? Number.POSITIVE_INFINITY)) break;
    if (!isDue(job, opts.now)) continue;
    if (job.codex.enabled && !opts.allowCodex) continue;
    const claim = makeClaim(opts.now, opts.ttlSec ?? 1200);
    job.claim = claim;
    job.state = "running";
    job.updatedAt = toLocalIso(opts.now);
    if (job.schedule.kind === "cron" || job.schedule.kind === "interval") {
      job.nextRunAt = computeNextRun(job.schedule, { now: opts.now, lastRunAt: opts.now });
    } else {
      job.repeat.completed += 1;
      if (job.repeat.times !== null && job.repeat.completed >= job.repeat.times) job.nextRunAt = null;
    }
    claimed.push({ job: structuredClone(job), claim });
  }
  return claimed;
}

export function claimManualRun(job: JobRecord, now: Date): Claim {
  return makeClaim(now, 1200);
}

export function completeClaim(store: JobStoreFile, jobId: string, runId: string, result: {
  status: OutputStatus;
  error?: string | null;
  output: OutputRef;
  finishedAt: Date;
  manual: boolean;
}): boolean {
  const job = store.jobs.find(item => item.id === jobId);
  if (!job) return false;
  if (!result.manual && job.claim?.runId !== runId) return false;
  job.claim = null;
  job.lastRunAt = result.output.startedAt;
  job.lastStatus = result.status;
  job.lastError = result.error ?? null;
  job.lastOutput = result.output;
  job.outputs = [...job.outputs, result.output].slice(-(job.outputKeep ?? 20));
  if (job.repeat.times !== null && job.repeat.completed >= job.repeat.times && job.schedule.kind === "once") {
    job.state = "completed";
  } else {
    job.state = result.status === "ok" || result.status === "skipped" ? "scheduled" : "error";
    if ((job.schedule.kind === "cron" || job.schedule.kind === "interval") && !result.manual) {
      job.nextRunAt = computeNextRun(job.schedule, { now: result.finishedAt, lastRunAt: result.finishedAt });
    }
  }
  job.updatedAt = toLocalIso(result.finishedAt);
  return true;
}

export function clearStaleClaims(store: JobStoreFile, now: Date): void {
  for (const job of store.jobs) {
    if (job.claim && toDate(job.claim.expiresAt) <= now) {
      job.claim = null;
      if (job.state === "running") job.state = "scheduled";
      job.updatedAt = toLocalIso(now);
    }
  }
}

function isDue(job: JobRecord, now: Date): boolean {
  if (!job.enabled || job.state === "paused" || job.state === "completed") return false;
  if (job.claim && toDate(job.claim.expiresAt) > now) return false;
  if (!job.nextRunAt) return false;
  return toDate(job.nextRunAt).getTime() <= now.getTime();
}

function makeClaim(now: Date, ttlSec: number): Claim {
  return {
    runId: safeRunId(now),
    claimedAt: toLocalIso(now),
    expiresAt: toLocalIso(new Date(now.getTime() + ttlSec * 1000)),
    pid: process.pid,
    host: hostname(),
  };
}
