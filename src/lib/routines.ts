import { isValidCron, nextCron, parseCron } from "./cron";
import type { Session } from "./types";

/** Local wall-clock times; the app runs on the user's machine, not a server. */
export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] }
  | { kind: "cron"; expression: string };

export type RunStatus = "running" | "ok" | "error";

export type RoutineRun = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  trigger: "schedule" | "manual";
};

/** The row as Rust hands it over; `runsJson` is parsed on the way in. */
export type RoutineRow = {
  id: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runsJson: string;
  createdBy: string | null;
};

export type Routine = Omit<RoutineRow, "runsJson"> & { runs: RoutineRun[] };

export type ScheduledRoutine = { routine: RoutineRow; session: Session; cwd: string };

/** What the editor holds. `id` is missing until the first save; `key` is for React. */
export type RoutineDraft = {
  id?: string;
  key: string;
  sessionId: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  runs: RoutineRun[];
};

export const MAX_RUNS = 20;

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

export function newRoutineDraft(sessionId: string): RoutineDraft {
  return {
    key: crypto.randomUUID(),
    sessionId,
    name: "",
    enabled: true,
    prompt: "",
    schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
    runs: [],
  };
}

export function parseRuns(raw: string): RoutineRun[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (run): run is RoutineRun =>
        typeof run === "object" && run !== null && typeof (run as RoutineRun).id === "string",
    );
  } catch {
    return [];
  }
}

export function fromRow(row: RoutineRow): Routine {
  const { runsJson, ...rest } = row;
  return { ...rest, runs: parseRuns(runsJson) };
}

export function toDraft(routine: Routine): RoutineDraft {
  return {
    id: routine.id,
    key: routine.id,
    sessionId: routine.sessionId,
    name: routine.name,
    enabled: routine.enabled,
    prompt: routine.prompt,
    schedule: parseSchedule(routine.schedule),
    runs: routine.runs,
  };
}

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
    // fall through to the default below
  }
  return TRIGGERS[3]!.schedule;
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

export function clockOf(schedule: Schedule): string {
  if (schedule.kind !== "daily") return "";
  return `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
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

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.join(",") === "1,2,3,4,5") return "Weekdays";
  if (sorted.join(",") === "0,6") return "Weekends";
  return sorted.map((day) => WEEKDAYS[day] ?? "").join(", ");
}

/** The card's second line: the instruction's opening, not a field of its own. */
export function summarize(prompt: string, max = 140): string {
  const text = prompt.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ") ?? "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The hidden turn that wakes the agent. It says who is talking so the reply
 * does not read the schedule back, and it allows silence: a routine that
 * found nothing should say nothing.
 */
export function wakePrompt(
  name: string,
  schedule: Schedule,
  trigger: RoutineRun["trigger"],
  prompt: string,
  by: string | null = null,
): string {
  const when =
    schedule.kind === "cron"
      ? `on the cron schedule ${schedule.expression}`
      : describeSchedule(schedule).replace(/^Every/, "every");
  const whose = by ? `a standing order ${by} set up for you` : "your own standing order";
  const cue =
    trigger === "manual"
      ? `[routine] "${name}" was run on demand. The user pressed Run now in the app; it normally runs ${when}.`
      : `[routine] "${name}" is due (${when}). This is ${whose} firing on schedule, not a message the user just typed.`;
  return `${cue}\nWhat you saved to do each time:\n${prompt.trim()}\n\nCarry it out now. Report what matters in one short message. If nothing changed and the instruction does not ask for a report, end without filler.`;
}

/** Newest first, capped, so the JSON column never grows past a screen of history. */
export function pushRun(runs: RoutineRun[], run: RoutineRun): RoutineRun[] {
  return [run, ...runs.filter((row) => row.id !== run.id)].slice(0, MAX_RUNS);
}
