import { Select } from "@cloudflare/kumo";
import { ClockIcon } from "@phosphor-icons/react";
import { isValidCron } from "../lib/cron";
import {
  clockOf,
  describeSchedule,
  nextRun,
  triggerOf,
  withTrigger,
  TRIGGERS,
  WEEKDAYS,
  type Schedule,
} from "../lib/routines";
import { dayLabel } from "../lib/time";

type Props = {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
};

const FIELD =
  "h-8 rounded-md bg-kumo-control px-2 text-kumo-default ring ring-kumo-line outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";

/** Weeks read Monday-first here; the stored numbers stay Date#getDay. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const PRESET_MINUTES = new Set([30, 60, 180]);

/** Stands for an interval an agent set that no preset spells; picking it changes nothing. */
const KEEP = "keep";

/** When the routine fires: a cadence, plus whatever that cadence still needs. */
export function RoutineTrigger({ schedule, onChange }: Props) {
  const trigger = triggerOf(schedule);
  const valid = schedule.kind !== "cron" || isValidCron(schedule.expression);
  const next = valid ? nextRun(schedule) : null;
  const offPreset = schedule.kind === "interval" && !PRESET_MINUTES.has(schedule.minutes);
  const items = TRIGGERS.map((item) => ({ value: item.id as string, label: item.label }));
  if (offPreset) items.unshift({ value: KEEP, label: describeSchedule(schedule) });

  const pickTime = (value: string) => {
    if (schedule.kind !== "daily") return;
    const [hour, minute] = value.split(":").map(Number);
    if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return;
    onChange({ ...schedule, hour, minute });
  };

  // A week with no day selected would never fire, so the last one cannot be dropped.
  const toggleDay = (day: number) => {
    if (schedule.kind !== "daily") return;
    const days = schedule.days.includes(day)
      ? schedule.days.filter((value) => value !== day)
      : [...schedule.days, day];
    if (days.length > 0) onChange({ ...schedule, days });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-sidebar p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Trigger"
          size="sm"
          className="w-44"
          value={offPreset ? KEEP : trigger}
          onValueChange={(value) =>
            value && value !== KEEP && onChange(withTrigger(schedule, value as typeof trigger))
          }
          items={items}
        />
        {schedule.kind === "daily" && (
          <input
            type="time"
            aria-label="Time"
            value={clockOf(schedule)}
            onChange={(event) => pickTime(event.target.value)}
            className={`${FIELD} w-[112px] tabular-nums`}
          />
        )}
        {schedule.kind === "cron" && (
          <input
            aria-label="Cron expression"
            spellCheck={false}
            value={schedule.expression}
            placeholder="0 9 * * 1"
            onChange={(event) => onChange({ kind: "cron", expression: event.target.value })}
            className={`${FIELD} w-44 font-mono ${valid ? "" : "ring-danger"}`}
          />
        )}
      </div>

      {trigger === "weekly" && schedule.kind === "daily" && (
        <div className="flex flex-wrap gap-1">
          {WEEK_ORDER.map((day) => {
            const on = schedule.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(day)}
                className={`h-7 w-11 rounded-md text-[12px] transition-colors ${
                  on ? "bg-kumo-brand text-kumo-inverse" : "bg-kumo-control text-kumo-subtle hover:bg-hover"
                }`}
              >
                {WEEKDAYS[day]}
              </button>
            );
          })}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[12px] text-kumo-subtle">
        <ClockIcon className="size-3.5 shrink-0" />
        {!valid ? (
          <span className="text-danger">
            Five fields: minute hour day-of-month month day-of-week
          </span>
        ) : next === null ? (
          <span className="text-danger">This pattern never comes around</span>
        ) : (
          <span>Next run {dayLabel(next)}</span>
        )}
      </p>
    </div>
  );
}
