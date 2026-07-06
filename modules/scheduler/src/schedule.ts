import { type Schedule } from "./types.js";
import { addMinutes, toDate, toLocalIso } from "./time.js";

type FieldSpec = { min: number; max: number; sundaySeven?: boolean };
type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

const DURATION_RE = /^(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/i;

export function parseDurationMinutes(input: string): number | null {
  const match = input.trim().match(DURATION_RE);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Invalid duration: ${input}`);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("m")) return amount;
  if (unit.startsWith("h")) return amount * 60;
  return amount * 24 * 60;
}

export function parseSchedule(input: string, opts: { now?: string | Date } = {}): Schedule {
  const text = input.trim();
  if (!text) throw new Error("Missing schedule input");
  if (text.startsWith("@")) throw new Error(`Unsupported cron alias: ${text}`);

  const every = text.match(/^every\s+(.+)$/i);
  if (every) {
    const minutes = parseDurationMinutes(every[1]!);
    if (minutes === null) throw new Error(`Invalid interval schedule: ${text}`);
    return { kind: "interval", minutes };
  }

  const fields = text.split(/\s+/);
  if (fields.length === 5) {
    validateCronExpr(text);
    return { kind: "cron", expr: fields.join(" "), timezone: "local" };
  }
  if (fields.length === 6) throw new Error("Unsupported cron schedule: expected exactly 5 fields");

  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ISO timestamp: ${text}`);
    return { kind: "once", runAt: toLocalIso(parsed), timezone: "local" };
  }

  const minutes = parseDurationMinutes(text);
  if (minutes !== null) return { kind: "once", runAt: toLocalIso(addMinutes(toDate(opts.now), minutes)), timezone: "local" };

  throw new Error(`Unsupported schedule syntax: ${text}`);
}

export function computeNextRun(schedule: Schedule, opts: { now?: string | Date; lastRunAt?: string | Date | null } = {}): string | null {
  const now = toDate(opts.now);
  if (schedule.kind === "once") {
    if (opts.lastRunAt) return null;
    return schedule.runAt;
  }
  if (schedule.kind === "interval") {
    const base = opts.lastRunAt ? toDate(opts.lastRunAt) : now;
    return toLocalIso(addMinutes(base, schedule.minutes));
  }
  return toLocalIso(computeNextCronRun(schedule.expr, opts.lastRunAt ? toDate(opts.lastRunAt) : now));
}

export function validateCronExpr(expr: string): void {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression "${expr}": expected 5 fields`);
  parseCronField(parts[0]!, { min: 0, max: 59 });
  parseCronField(parts[1]!, { min: 0, max: 23 });
  parseCronField(parts[2]!, { min: 1, max: 31 });
  parseCronField(parts[3]!, { min: 1, max: 12 });
  parseCronField(parts[4]!, { min: 0, max: 7, sundaySeven: true });
}

export function parseCronField(field: string, spec: FieldSpec): Set<number> {
  if (!field || /[A-Za-z?LW#]/.test(field)) throw new Error(`Unsupported cron field: ${field}`);
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`Invalid cron field: ${field}`);
    const [rangePart, stepPart] = part.split("/");
    if (part.split("/").length > 2) throw new Error(`Invalid cron step: ${part}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart?.includes("-")) {
      const [a, b] = rangePart.split("-");
      start = parseCronNumber(a!, spec);
      end = parseCronNumber(b!, spec);
      if (start > end) throw new Error(`Invalid cron range: ${part}`);
    } else {
      start = parseCronNumber(rangePart!, spec);
      end = start;
    }
    for (let value = start; value <= end; value += step) values.add(normalizeCronValue(value, spec));
  }
  return values;
}

export function isCronFieldRestricted(field: string): boolean {
  return field !== "*";
}

export function computeNextCronRun(expr: string, base: Date): Date {
  const parsed = parseCron(expr);
  const candidate = new Date(base.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = new Date(base.getTime());
  deadline.setFullYear(deadline.getFullYear() + 5);
  while (candidate <= deadline) {
    if (cronMatches(candidate, parsed)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron expression has no run within 5 years: ${expr}`);
}

export function cronMatches(date: Date, parsed: ParsedCron): boolean {
  if (!parsed.month.has(date.getMonth() + 1)) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.minute.has(date.getMinutes())) return false;
  const domMatch = parsed.dom.has(date.getDate());
  const dowMatch = parsed.dow.has(date.getDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch;
  if (parsed.domRestricted) return domMatch;
  if (parsed.dowRestricted) return dowMatch;
  return true;
}

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression "${expr}": expected 5 fields`);
  return {
    minute: parseCronField(parts[0]!, { min: 0, max: 59 }),
    hour: parseCronField(parts[1]!, { min: 0, max: 23 }),
    dom: parseCronField(parts[2]!, { min: 1, max: 31 }),
    month: parseCronField(parts[3]!, { min: 1, max: 12 }),
    dow: parseCronField(parts[4]!, { min: 0, max: 7, sundaySeven: true }),
    domRestricted: isCronFieldRestricted(parts[2]!),
    dowRestricted: isCronFieldRestricted(parts[4]!),
  };
}

function parseCronNumber(value: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid cron number: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < spec.min || parsed > spec.max) throw new Error(`Cron value out of range: ${value}`);
  return parsed;
}

function normalizeCronValue(value: number, spec: FieldSpec): number {
  if (spec.sundaySeven && value === 7) return 0;
  return value;
}
