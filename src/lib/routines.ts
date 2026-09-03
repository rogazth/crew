import type { Session } from "./types";

/** Local wall-clock times; the app runs on the user's machine, not a server. */
export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] };

export type Routine = {
  id: string;
  sessionId: string;
  enabled: boolean;
  prompt: string;
  schedule: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

export type ScheduledRoutine = { routine: Routine; session: Session; cwd: string };

export type RoutineDraft = {
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
};

export const CADENCES: Array<{ id: string; label: string; schedule: Schedule }> = [
  { id: "30m", label: "Every 30 minutes", schedule: { kind: "interval", minutes: 30 } },
  { id: "1h", label: "Every hour", schedule: { kind: "interval", minutes: 60 } },
  { id: "3h", label: "Every 3 hours", schedule: { kind: "interval", minutes: 180 } },
  { id: "daily", label: "Every day at", schedule: { kind: "daily", hour: 9, minute: 0, days: [] } },
  { id: "weekdays", label: "Weekdays at", schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] } },
  { id: "mondays", label: "Mondays at", schedule: { kind: "daily", hour: 9, minute: 0, days: [1] } },
];

export const DEFAULT_ROUTINE: RoutineDraft = {
  enabled: false,
  prompt: "",
  schedule: CADENCES[3]!.schedule,
};

export function cadenceOf(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    return CADENCES.find((c) => c.schedule.kind === "interval" && c.schedule.minutes === schedule.minutes)?.id ?? "1h";
  }
  const key = schedule.days.join(",");
  return (
    CADENCES.find((c) => c.schedule.kind === "daily" && c.schedule.days.join(",") === key)?.id ?? "daily"
  );
}

export function parseSchedule(raw: string): Schedule {
  try {
    const value = JSON.parse(raw) as Partial<Schedule>;
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
  } catch {
    // fall through to the default below
  }
  return DEFAULT_ROUTINE.schedule;
}

/** Next due time strictly after `from`. Daily schedules skip days not in `days`. */
export function nextRun(schedule: Schedule, from: number): number {
  if (schedule.kind === "interval") return from + schedule.minutes * 60_000;
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

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    if (schedule.minutes % 60 === 0) {
      const hours = schedule.minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return `Every ${schedule.minutes} minutes`;
  }
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const cadence = CADENCES.find((c) => c.id === cadenceOf(schedule))?.label ?? "Every day at";
  return `${cadence} ${time}`;
}
