import clsx from "clsx";
import { dayLabel, nextRun, type Schedule } from "@crew/fixtures";
import { Input, Segmented } from "@/ui";
import {
  TRIGGERS,
  WEEKDAYS,
  WEEKDAY_NAMES,
  cronError,
  scheduleFor,
  scheduleLabel,
  timeValue,
  triggerOf,
  withTime,
  type TriggerKind,
} from "@/lib/cron";

/** The only thing that can make a schedule unsaveable is a cron a human mistyped. */
export function scheduleError(schedule: Schedule): string | null {
  return schedule.kind === "cron" ? cronError(schedule.expression) : null;
}

export function TriggerControl({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (next: Schedule) => void;
}) {
  const kind = triggerOf(schedule);
  const error = scheduleError(schedule);
  const due = error ? null : nextRun(schedule);

  const toggleDay = (day: number) => {
    if (schedule.kind !== "daily") return;
    const on = schedule.days.includes(day);
    // A weekly routine with no day left is a daily routine wearing a costume.
    if (on && schedule.days.length === 1) return;
    onChange({
      ...schedule,
      days: on ? schedule.days.filter((d) => d !== day) : [...schedule.days, day].sort(),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Segmented<TriggerKind>
        label="Trigger"
        value={kind}
        options={TRIGGERS.map((trigger) => ({ id: trigger.id, label: trigger.label }))}
        onChange={(next) => onChange(scheduleFor(next, schedule))}
        className="max-w-full"
      />

      {kind === "day" || kind === "week" ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tracking-wide text-ink-3 uppercase">at</span>
            <TimeInput
              value={timeValue(schedule)}
              onChange={(value) => onChange(withTime(schedule, value))}
            />
          </div>
          {kind === "week" ? (
            <div className="flex items-center gap-1" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((label, day) => {
                const on = schedule.kind === "daily" && schedule.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_NAMES[day] ?? label}
                    onClick={() => toggleDay(day)}
                    className={clsx(
                      "size-[var(--control-h)] shrink-0 rounded-[var(--r)] border font-mono text-xs",
                      "transition-colors duration-[var(--fast)]",
                      on
                        ? "border-ink bg-ink text-on-ink"
                        : "border-rule bg-raised text-ink-3 hover:border-rule-strong hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {schedule.kind === "cron" ? (
        <div className="flex flex-col gap-1">
          <Input
            mono
            aria-label="Cron expression"
            spellCheck={false}
            autoComplete="off"
            placeholder="0 4 * * 1"
            className="max-w-[220px]"
            invalid={error !== null}
            value={schedule.expression}
            onChange={(event) => onChange({ kind: "cron", expression: event.target.value })}
          />
          <p className={clsx("font-mono text-xs", error ? "text-red-ink" : "text-ink-4")}>
            {error ?? "minute hour day-of-month month day-of-week"}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-ink-4">
        <span className="text-ink-3">{error ? "—" : scheduleLabel(schedule)}</span>
        <span aria-hidden>·</span>
        <span>{due ? `next ${dayLabel(due)}` : "no next run"}</span>
      </div>
    </div>
  );
}

/**
 * The native time control follows `color-scheme`, which the theme already sets;
 * everything else here is the ordinary input shell.
 */
function TimeInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <Input
      mono
      type="time"
      aria-label="Time of day"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={clsx(
        "max-w-[140px] [color-scheme:inherit]",
        "[&::-webkit-calendar-picker-indicator]:opacity-50",
        "[&::-webkit-calendar-picker-indicator]:hover:opacity-100",
      )}
    />
  );
}
