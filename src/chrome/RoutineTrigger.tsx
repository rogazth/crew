import { Select } from "@cloudflare/kumo";
import { ClockIcon } from "@phosphor-icons/react";
import { clockOf, triggerOf, WEEKDAYS, type Schedule } from "../lib/routines";
import {
  WEEK_ORDER,
  atTime,
  pickTrigger,
  runOutlook,
  toggleDay,
  triggerMenu,
} from "../lib/routineTrigger";
import { dayLabel } from "../lib/time";

type Props = {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
};

const FIELD =
  "h-8 rounded-md bg-kumo-control px-2 text-kumo-default ring ring-kumo-line outline-none focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50";

/** When the routine fires: a cadence, plus whatever that cadence still needs. */
export function RoutineTrigger({ schedule, onChange }: Props) {
  const trigger = triggerOf(schedule);
  const { valid, next } = runOutlook(schedule);
  const menu = triggerMenu(schedule);
  const change = (updated: Schedule | null) => {
    if (updated) onChange(updated);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-sidebar p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Trigger"
          size="sm"
          className="w-44"
          value={menu.value}
          onValueChange={(value) => change(pickTrigger(schedule, value))}
          items={menu.items}
        />
        {schedule.kind === "daily" && (
          <input
            type="time"
            aria-label="Time"
            value={clockOf(schedule)}
            onChange={(event) => change(atTime(schedule, event.target.value))}
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
                onClick={() => change(toggleDay(schedule, day))}
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
