import { isValidCron } from "./cron";
import {
  describeSchedule,
  nextRun,
  triggerOf,
  withTrigger,
  TRIGGERS,
  type Schedule,
  type TriggerId,
} from "./routines";

/** Weeks read Monday-first here; the stored numbers stay Date#getDay. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PRESET_MINUTES = new Set([30, 60, 180]);

/** Stands for an interval an agent set that no preset spells; picking it changes nothing. */
export const KEEP = "keep";

/** The trigger menu's choices and its current value. An interval no preset spells leads the list as itself. */
export function triggerMenu(schedule: Schedule): { value: string; items: { value: string; label: string }[] } {
  const offPreset = schedule.kind === "interval" && !PRESET_MINUTES.has(schedule.minutes);
  const items = TRIGGERS.map((item) => ({ value: item.id as string, label: item.label }));
  if (offPreset) items.unshift({ value: KEEP, label: describeSchedule(schedule) });
  return { value: offPreset ? KEEP : triggerOf(schedule), items };
}

/** The schedule a trigger pick makes, or null when the pick changes nothing. */
export function pickTrigger(schedule: Schedule, value: string | null | undefined): Schedule | null {
  if (!value || value === KEEP) return null;
  return withTrigger(schedule, value as TriggerId);
}

/** A daily schedule moved to an `HH:MM` time, or null when the input is not one. */
export function atTime(schedule: Schedule, value: string): Schedule | null {
  if (schedule.kind !== "daily") return null;
  const [hour, minute] = value.split(":").map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return { ...schedule, hour, minute };
}

/** A week with no day selected would never fire, so the last day cannot be dropped: that returns null. */
export function toggleDay(schedule: Schedule, day: number): Schedule | null {
  if (schedule.kind !== "daily") return null;
  const days = schedule.days.includes(day) ? schedule.days.filter((value) => value !== day) : [...schedule.days, day];
  return days.length > 0 ? { ...schedule, days } : null;
}

/** Whether the schedule parses, and when it next fires after `from` (null: never). */
export function runOutlook(schedule: Schedule, from = Date.now()): { valid: boolean; next: number | null } {
  const valid = schedule.kind !== "cron" || isValidCron(schedule.expression);
  return { valid, next: valid ? nextRun(schedule, from) : null };
}
