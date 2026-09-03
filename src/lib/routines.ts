import type { Session } from "./types";

/** Local wall-clock times; the app runs on the user's machine, not a server. */
export type Schedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; days: number[] };

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
};

export type Routine = Omit<RoutineRow, "runsJson"> & { runs: RoutineRun[] };

export type ScheduledRoutine = { routine: RoutineRow; session: Session; cwd: string };

/** What the sheet edits. `id` is missing until the first save; `key` is for React. */
export type RoutineDraft = {
  id?: string;
  key: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  runs: RoutineRun[];
};

export const MAX_RUNS = 20;

export const CADENCES: Array<{ id: string; label: string; schedule: Schedule }> = [
  { id: "30m", label: "Every 30 minutes", schedule: { kind: "interval", minutes: 30 } },
  { id: "1h", label: "Every hour", schedule: { kind: "interval", minutes: 60 } },
  { id: "3h", label: "Every 3 hours", schedule: { kind: "interval", minutes: 180 } },
  { id: "daily", label: "Every day at", schedule: { kind: "daily", hour: 9, minute: 0, days: [] } },
  { id: "weekdays", label: "Weekdays at", schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] } },
  { id: "mondays", label: "Mondays at", schedule: { kind: "daily", hour: 9, minute: 0, days: [1] } },
];

export function newRoutineDraft(): RoutineDraft {
  return { key: crypto.randomUUID(), name: "", enabled: true, prompt: "", schedule: CADENCES[3]!.schedule, runs: [] };
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
    name: routine.name,
    enabled: routine.enabled,
    prompt: routine.prompt,
    schedule: parseSchedule(routine.schedule),
    runs: routine.runs,
  };
}

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
  return CADENCES[3]!.schedule;
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

/**
 * The hidden turn that wakes the agent. It says who is talking so the reply
 * does not read the schedule back, and it allows silence: a routine that
 * found nothing should say nothing.
 */
export function wakePrompt(name: string, schedule: Schedule, trigger: RoutineRun["trigger"], prompt: string): string {
  const when = describeSchedule(schedule).replace(/^Every/, "every");
  const cue =
    trigger === "manual"
      ? `[routine] "${name}" was run on demand. The user pressed Test run in the app; it normally runs ${when}.`
      : `[routine] "${name}" is due (${when}). This is your own standing order firing on schedule, not a message the user just typed.`;
  return `${cue}\nWhat you saved to do each time:\n${prompt.trim()}\n\nCarry it out now. Report what matters in one short message. If nothing changed and the instruction does not ask for a report, end without filler.`;
}

/** Newest first, capped, so the JSON column never grows past a screen of history. */
export function pushRun(runs: RoutineRun[], run: RoutineRun): RoutineRun[] {
  return [run, ...runs.filter((row) => row.id !== run.id)].slice(0, MAX_RUNS);
}
