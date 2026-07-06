import { resolve } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { scanCredentialExfil } from "./safety.js";
import { type CreateJobInput, type SchedulerBlueprint } from "./types.js";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const CATALOG: SchedulerBlueprint[] = [
  {
    key: "custom-reminder",
    title: "Custom reminder",
    description: "Write a concise scheduled reminder.",
    slots: [
      { name: "message", type: "text", label: "Message", required: true },
      { name: "time", type: "time", label: "Time", default: "09:00" },
      { name: "recurrence", type: "enum", label: "Recurrence", default: "daily", options: ["once", "daily", "weekdays", "weekly"] },
    ],
  },
  {
    key: "repo-health-check",
    title: "Repo health check",
    description: "Inspect a repository read-only and summarize its health.",
    slots: [
      { name: "repo", type: "path", label: "Repository", required: true },
      { name: "time", type: "time", label: "Time", default: "09:00" },
      { name: "recurrence", type: "enum", label: "Recurrence", default: "weekdays", options: ["daily", "weekdays", "weekly"] },
      { name: "focus", type: "text", label: "Focus", default: "git status, tests, stale TODOs" },
    ],
  },
];

export function listBlueprints(): SchedulerBlueprint[] {
  return structuredClone(CATALOG);
}

export function getBlueprint(key: string): SchedulerBlueprint {
  const blueprint = CATALOG.find(item => item.key === key);
  if (!blueprint) throw new Error(`Unknown blueprint: ${key}`);
  return blueprint;
}

export function fillBlueprint(key: string, values: Record<string, string>, opts: { now?: string | Date } = {}): CreateJobInput {
  const blueprint = getBlueprint(key);
  const slots = validateSlots(blueprint, values);
  if (key === "custom-reminder") {
    const time = parseTime(slots.time);
    return {
      name: "Custom reminder",
      scheduleInput: scheduleFor(slots.recurrence, time, opts.now),
      prompt: `Write a concise reminder for this scheduled item: ${slots.message}`,
      codex: { enabled: true, sandbox: "read-only" },
    };
  }
  if (key === "repo-health-check") {
    const time = parseTime(slots.time);
    return {
      name: "Repo health check",
      scheduleInput: scheduleFor(slots.recurrence, time, opts.now),
      cwd: slots.repo,
      prompt: `Inspect this repository in read-only mode and summarize its health. Focus on ${slots.focus}. Avoid destructive commands and do not edit files.`,
      codex: { enabled: true, sandbox: "read-only" },
    };
  }
  throw new Error(`Unhandled blueprint: ${key}`);
}

function validateSlots(blueprint: SchedulerBlueprint, values: Record<string, string>): Record<string, string> {
  const known = new Set(blueprint.slots.map(slot => slot.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) throw new Error(`Unknown slot for ${blueprint.key}: ${name}`);
  }
  const out: Record<string, string> = {};
  for (const slot of blueprint.slots) {
    const raw = values[slot.name] ?? slot.default;
    if ((raw === undefined || raw === "") && slot.required) throw new Error(`Missing required slot: ${slot.name}`);
    if (raw === undefined) continue;
    scanCredentialExfil(raw, `blueprint slot ${slot.name}`);
    if (slot.type === "time" && !TIME_RE.test(raw)) throw new Error(`Invalid time slot ${slot.name}: expected HH:MM`);
    if (slot.type === "enum" && !slot.options?.includes(raw)) throw new Error(`Invalid ${slot.name}: expected one of ${slot.options?.join(", ")}`);
    if (slot.type === "path") {
      const path = realpathSync(resolve(raw));
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Path slot is not an existing directory: ${raw}`);
      out[slot.name] = path;
    } else {
      out[slot.name] = raw;
    }
  }
  return out;
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = value.match(TIME_RE);
  if (!match) throw new Error(`Invalid time: ${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function scheduleFor(recurrence: string, time: { hour: number; minute: number }, now?: string | Date): string {
  if (recurrence === "daily") return `${time.minute} ${time.hour} * * *`;
  if (recurrence === "weekdays") return `${time.minute} ${time.hour} * * 1-5`;
  if (recurrence === "weekly") return `${time.minute} ${time.hour} * * 1`;
  if (recurrence === "once") {
    const base = now ? new Date(now) : new Date();
    const runAt = new Date(base.getTime());
    runAt.setHours(time.hour, time.minute, 0, 0);
    if (runAt <= base) runAt.setDate(runAt.getDate() + 1);
    return runAt.toISOString();
  }
  throw new Error(`Unsupported recurrence: ${recurrence}`);
}
