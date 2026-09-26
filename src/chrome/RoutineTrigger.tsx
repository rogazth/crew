import { ClockIcon } from "lucide-react";
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
import { Select, TextInput, type Option } from "./kit";

type Props = {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
};

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
  const items: Option<string>[] = TRIGGERS.map((item) => ({ value: item.id, label: item.label }));
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
    <div className="flex flex-col gap-3 rounded-xl bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          label="Trigger"
          value={offPreset ? KEEP : trigger}
          onChange={(value) => value !== KEEP && onChange(withTrigger(schedule, value as typeof trigger))}
          options={items}
        />
        {/* The kit's fields fill their row; these wrappers give them a width. */}
        {schedule.kind === "daily" && (
          <div className="w-[112px]">
            <TextInput
              type="time"
              aria-label="Time"
              value={clockOf(schedule)}
              onChange={(event) => pickTime(event.target.value)}
              className="tabular-nums"
            />
          </div>
        )}
        {schedule.kind === "cron" && (
          <div className="w-44">
            <TextInput
              aria-label="Cron expression"
              aria-invalid={!valid}
              value={schedule.expression}
              placeholder="0 9 * * 1"
              onChange={(event) => onChange({ kind: "cron", expression: event.target.value })}
              className="font-mono"
            />
          </div>
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
                className={`h-7 w-11 rounded-md text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 ${
                  on
                    ? "bg-accent text-inverse"
                    : "bg-canvas text-text-muted ring ring-border hover:text-text"
                }`}
              >
                {WEEKDAYS[day]}
              </button>
            );
          })}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[12px] text-text-muted">
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
