/** Schedules, cron parsing and the next-due calculation. Ported from the app. */
import type { Schedule } from "./types";

export type TriggerId = "30m" | "hourly" | "3h" | "daily" | "weekly" | "cron";

export const DEFAULT_CRON = "0 9 * * 1";

export const TRIGGERS: Array<{ id: TriggerId; label: string; schedule: Schedule }> = [
  { id: "30m", label: "Every 30 minutes", schedule: { kind: "interval", minutes: 30 } },
  { id: "hourly", label: "Every hour", schedule: { kind: "interval", minutes: 60 } },
  { id: "3h", label: "Every 3 hours", schedule: { kind: "interval", minutes: 180 } },
  { id: "daily", label: "Every day", schedule: { kind: "daily", hour: 9, minute: 0, days: [] } },
  { id: "weekly", label: "Every week", schedule: { kind: "daily", hour: 9, minute: 0, days: [1] } },
  { id: "cron", label: "Custom cron", schedule: { kind: "cron", expression: DEFAULT_CRON } },
];

/** Sunday first, matching Date#getDay. */
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function triggerOf(schedule: Schedule): TriggerId {
  if (schedule.kind === "cron") return "cron";
  if (schedule.kind === "interval") {
    return schedule.minutes === 30 ? "30m" : schedule.minutes === 180 ? "3h" : "hourly";
  }
  return schedule.days.length > 0 ? "weekly" : "daily";
}

/** Switching trigger keeps whatever the new shape can carry over. */
export function withTrigger(schedule: Schedule, id: TriggerId): Schedule {
  const base = TRIGGERS.find((trigger) => trigger.id === id)?.schedule ?? TRIGGERS[3]!.schedule;
  if (base.kind !== "daily" || schedule.kind !== "daily") return base;
  return { ...base, hour: schedule.hour, minute: schedule.minute };
}

export function parseSchedule(raw: string): Schedule {
  try {
    const value = JSON.parse(raw) as Partial<Schedule> & { expression?: unknown };
    if (value.kind === "interval" && typeof value.minutes === "number" && value.minutes >= 1) {
      return { kind: "interval", minutes: value.minutes };
    }
    if (value.kind === "daily" && typeof value.hour === "number" && typeof value.minute === "number") {
      return {
        kind: "daily",
        hour: value.hour,
        minute: value.minute,
        days: Array.isArray(value.days) ? value.days.filter((d): d is number => typeof d === "number") : [],
      };
    }
    if (value.kind === "cron" && typeof value.expression === "string" && isValidCron(value.expression)) {
      return { kind: "cron", expression: value.expression };
    }
  } catch {
    // fall through to the default
  }
  return TRIGGERS[3]!.schedule;
}

export const serializeSchedule = (schedule: Schedule): string => JSON.stringify(schedule);

export function clockOf(schedule: Schedule): string {
  if (schedule.kind !== "daily") return "";
  return `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
}

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "Weekdays";
  if (sorted.join(",") === "0,6") return "Weekends";
  return sorted.map((day) => WEEKDAYS[day] ?? "").join(", ");
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "cron") return `Cron ${schedule.expression}`;
  if (schedule.kind === "interval") {
    if (schedule.minutes % 60 === 0) {
      const hours = schedule.minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return `Every ${schedule.minutes} minutes`;
  }
  return `${describeDays(schedule.days)} at ${clockOf(schedule)}`;
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export type CronSpec = {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
};

function field(raw: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let from = min;
    let to = max;
    if (range !== "*" && range !== undefined) {
      const bounds = range.split("-");
      if (bounds.length === 1) {
        const only = Number(bounds[0]);
        if (!Number.isInteger(only) || only < min || only > max) return null;
        from = only;
        to = stepRaw === undefined ? only : max;
      } else if (bounds.length === 2) {
        from = Number(bounds[0]);
        to = Number(bounds[1]);
        if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
        if (from < min || to > max || from > to) return null;
      } else {
        return null;
      }
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null;
}

export function parseCron(expression: string): CronSpec | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = field(parts[0]!, 0, 59);
  const hours = field(parts[1]!, 0, 23);
  const daysOfMonth = field(parts[2]!, 1, 31);
  const months = field(parts[3]!, 1, 12);
  // Both 0 and 7 mean Sunday, as everyone's crontab does.
  const daysOfWeek = field(parts[4]!.replace(/7/g, "0"), 0, 6);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export const isValidCron = (expression: string): boolean => parseCron(expression) !== null;

const WILDCARD_DOM = (spec: CronSpec) => spec.daysOfMonth.length === 31;
const WILDCARD_DOW = (spec: CronSpec) => spec.daysOfWeek.length === 7;

/** Next match strictly after `from`, or null when the spec can never match. */
export function nextCron(spec: CronSpec, from: number): number | null {
  const at = new Date(from);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  // Four years covers every leap-year case a five-field cron can express.
  const limit = from + 4 * 366 * 86_400_000;
  while (at.getTime() <= limit) {
    if (!spec.months.includes(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    // A cron with both day fields set matches either one, not both.
    const domOk = spec.daysOfMonth.includes(at.getDate());
    const dowOk = spec.daysOfWeek.includes(at.getDay());
    const dayOk =
      WILDCARD_DOM(spec) && WILDCARD_DOW(spec)
        ? true
        : WILDCARD_DOM(spec)
          ? dowOk
          : WILDCARD_DOW(spec)
            ? domOk
            : domOk || dowOk;
    if (!dayOk) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.includes(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minutes.includes(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at.getTime();
  }
  return null;
}

/** Next due time strictly after `from`, or null when a cron can never match again. */
export function nextRun(schedule: Schedule, from = Date.now()): number | null {
  if (schedule.kind === "interval") return from + schedule.minutes * 60_000;
  if (schedule.kind === "cron") {
    const spec = parseCron(schedule.expression);
    return spec ? nextCron(spec, from) : null;
  }
  const at = new Date(from);
  at.setSeconds(0, 0);
  at.setHours(schedule.hour, schedule.minute, 0, 0);
  if (at.getTime() <= from) at.setDate(at.getDate() + 1);
  for (let i = 0; i < 8; i += 1) {
    if (schedule.days.length === 0 || schedule.days.includes(at.getDay())) return at.getTime();
    at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

/** The card's second line: the instruction's opening, not a field of its own. */
export function summarizePrompt(prompt: string, max = 140): string {
  const text = prompt.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ") ?? "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
