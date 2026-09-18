import type { Schedule } from "@crew/fixtures";

export type TriggerKind = "30m" | "hour" | "3h" | "day" | "week" | "cron";

export const TRIGGERS: Array<{ id: TriggerKind; label: string }> = [
  { id: "30m", label: "Every 30 minutes" },
  { id: "hour", label: "Every hour" },
  { id: "3h", label: "Every 3 hours" },
  { id: "day", label: "Every day" },
  { id: "week", label: "Every week" },
  { id: "cron", label: "Custom cron" },
];

export const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function triggerOf(schedule: Schedule): TriggerKind {
  if (schedule.kind === "cron") return "cron";
  if (schedule.kind === "interval") {
    if (schedule.minutes <= 30) return "30m";
    if (schedule.minutes <= 60) return "hour";
    return "3h";
  }
  return schedule.days.length > 0 ? "week" : "day";
}

export function scheduleFor(kind: TriggerKind, held: Schedule): Schedule {
  const time = held.kind === "daily" ? { hour: held.hour, minute: held.minute } : { hour: 9, minute: 0 };
  switch (kind) {
    case "30m":
      return { kind: "interval", minutes: 30 };
    case "hour":
      return { kind: "interval", minutes: 60 };
    case "3h":
      return { kind: "interval", minutes: 180 };
    case "day":
      return { kind: "daily", ...time, days: [] };
    case "week":
      return { kind: "daily", ...time, days: held.kind === "daily" && held.days.length ? held.days : [1] };
    case "cron":
      return { kind: "cron", expression: held.kind === "cron" ? held.expression : "0 4 * * 1" };
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function timeValue(schedule: Schedule): string {
  return schedule.kind === "daily" ? `${pad(schedule.hour)}:${pad(schedule.minute)}` : "09:00";
}

export function withTime(schedule: Schedule, value: string): Schedule {
  if (schedule.kind !== "daily") return schedule;
  const [hour, minute] = value.split(":").map((n) => Number.parseInt(n, 10));
  return { ...schedule, hour: hour ?? 0, minute: minute ?? 0 };
}

function clockLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${pad(minute)} ${suffix}`;
}

/** "Every 3 hours", "Weekdays at 9:00 AM", "0 4 * * 1". */
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === "cron") return schedule.expression;
  if (schedule.kind === "interval") {
    const { minutes } = schedule;
    if (minutes < 60) return `Every ${minutes} minutes`;
    if (minutes === 60) return "Every hour";
    if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  const at = clockLabel(schedule.hour, schedule.minute);
  if (schedule.days.length === 0) return `Every day at ${at}`;
  const sorted = [...schedule.days].sort();
  if (sorted.join() === "1,2,3,4,5") return `Weekdays at ${at}`;
  if (sorted.length === 7) return `Every day at ${at}`;
  return `${sorted.map((d) => WEEKDAY_NAMES[d]?.slice(0, 3)).join(", ")} at ${at}`;
}

const FIELD = /^(\*|\d+|\d+-\d+|(\d+,)+\d+)(\/\d+)?$/;

export function cronError(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (expression.trim() === "") return "An expression is required.";
  if (fields.length !== 5) return `Five fields expected, got ${fields.length}.`;
  const names = ["minute", "hour", "day of month", "month", "day of week"];
  for (let i = 0; i < 5; i += 1) {
    if (!FIELD.test(fields[i]!)) return `The ${names[i]} field is not valid.`;
  }
  return null;
}
