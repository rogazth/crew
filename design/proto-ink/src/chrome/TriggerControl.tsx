import { useId, useRef } from "react";
import type { Schedule } from "@crew/fixtures";
import { dayLabel } from "@crew/fixtures";
import { clockLabel, cronError, dayName } from "@/lib/cron";
import { cx } from "@/lib/cx";
import { Field, Input, Select } from "@/ui";

type Mode = "every30" | "hourly" | "every3h" | "daily" | "weekly" | "cron";

const MODES: { value: Mode; label: string }[] = [
  { value: "every30", label: "Every 30 minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "every3h", label: "Every 3 hours" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "cron", label: "Custom cron" },
];

const FULL_WEEK = [0, 1, 2, 3, 4, 5, 6];

function modeOf(schedule: Schedule): Mode {
  if (schedule.kind === "cron") return "cron";
  if (schedule.kind === "daily") {
    // A daily rule that names a proper subset of the week *is* the weekly mode;
    // the fixture shape has no separate "weekly" kind.
    return schedule.days.length > 0 && schedule.days.length < 7 ? "weekly" : "daily";
  }
  if (schedule.minutes === 30) return "every30";
  if (schedule.minutes === 180) return "every3h";
  return "hourly";
}

/**
 * A rough reading of a cron expression: it understands a plain number or `*` in
 * the minute, hour and day-of-week fields and gives up on anything else. That is
 * honest for a prototype — a real next-fire needs a real cron engine.
 */
function nextFireHint(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [rawMinute, rawHour, rawDom, rawMonth, rawDow] = parts as [string, string, string, string, string];
  if (rawDom !== "*" || rawMonth !== "*") return null;
  if (!/^\d+$/.test(rawMinute) || !/^\d+$/.test(rawHour)) return null;
  const minute = Number(rawMinute);
  const hour = Number(rawHour);

  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);

  if (/^\d+$/.test(rawDow)) {
    const target = Number(rawDow) % 7;
    while (at.getDay() !== target) at.setDate(at.getDate() + 1);
  } else if (rawDow !== "*") {
    return null;
  }
  return `Next run ${dayLabel(at.getTime())}`;
}

export function TriggerControl({
  value,
  onChange,
}: {
  value: Schedule;
  onChange: (next: Schedule) => void;
}) {
  const cronId = useId();
  const timeId = useId();
  const mode = modeOf(value);

  /**
   * Switching away from "Every day" or "Custom cron" would otherwise throw away
   * the time and the expression the user typed. Remember the last of each so the
   * round trip is lossless within a session.
   */
  const memo = useRef({ hour: 9, minute: 0, days: [1, 2, 3, 4, 5], expression: "0 9 * * 1" });
  if (value.kind === "daily") {
    memo.current.hour = value.hour;
    memo.current.minute = value.minute;
    if (value.days.length > 0 && value.days.length < 7) memo.current.days = value.days;
  } else if (value.kind === "cron") {
    memo.current.expression = value.expression;
  }

  const hour = value.kind === "daily" ? value.hour : memo.current.hour;
  const minute = value.kind === "daily" ? value.minute : memo.current.minute;
  const days = mode === "weekly" && value.kind === "daily" ? value.days : memo.current.days;

  const setMode = (next: Mode) => {
    const { expression } = memo.current;
    switch (next) {
      case "every30":
        return onChange({ kind: "interval", minutes: 30 });
      case "hourly":
        return onChange({ kind: "interval", minutes: 60 });
      case "every3h":
        return onChange({ kind: "interval", minutes: 180 });
      case "daily":
        return onChange({ kind: "daily", hour, minute, days: [] });
      case "weekly":
        return onChange({ kind: "daily", hour, minute, days: days.length ? days : [1] });
      case "cron":
        return onChange({ kind: "cron", expression });
    }
  };

  const setTime = (nextHour: number, nextMinute: number) => {
    onChange({
      kind: "daily",
      hour: nextHour,
      minute: nextMinute,
      days: mode === "weekly" ? days : [],
    });
  };

  const toggleDay = (index: number) => {
    const on = days.includes(index);
    // One day must stay lit, otherwise the routine has no schedule at all.
    if (on && days.length === 1) return;
    const next = on ? days.filter((d) => d !== index) : [...days, index].sort((a, b) => a - b);
    onChange({ kind: "daily", hour, minute, days: next });
  };

  const expression = value.kind === "cron" ? value.expression : memo.current.expression;
  const error = mode === "cron" ? cronError(expression) : null;
  const hint = mode === "cron" ? (nextFireHint(expression) ?? "Minute, hour, day of month, month, day of week.") : null;

  return (
    <div className="flex flex-col gap-2.5">
      <Select
        value={mode}
        onValueChange={(next) => setMode(next as Mode)}
        options={MODES}
        width={200}
      />

      {(mode === "daily" || mode === "weekly") && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <label htmlFor={timeId} className="text-small text-tertiary">
              at
            </label>
            <Input
              id={timeId}
              type="time"
              icon="clock"
              value={clockLabel(hour, minute)}
              onChange={(event) => {
                const [h, m] = event.target.value.split(":");
                if (h && m) setTime(Number(h), Number(m));
              }}
              className={cx(
                "w-[148px] tnum",
                "[&_input::-webkit-calendar-picker-indicator]:opacity-45",
                "[&_input::-webkit-calendar-picker-indicator]:cursor-pointer",
                "hover:[&_input::-webkit-calendar-picker-indicator]:opacity-80",
              )}
            />
          </div>

          {mode === "weekly" && (
            <div
              role="group"
              aria-label="Days of the week"
              className="inline-flex w-fit items-center gap-0.5 rounded-md bg-[var(--fill-quaternary)] p-0.5 hairline-soft"
            >
              {FULL_WEEK.map((index) => {
                const on = days.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(index)}
                    className={cx(
                      "h-6 rounded-sm px-2 text-micro transition-colors duration-[var(--dur-2)]",
                      on
                        ? "bg-[var(--surface-canvas)] text-primary e1"
                        : "text-tertiary hover:text-secondary",
                    )}
                  >
                    {dayName(index)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {mode === "cron" && (
        <Field htmlFor={cronId} error={error} hint={hint} className="max-w-sm">
          <Input
            id={cronId}
            value={expression}
            invalid={!!error}
            spellCheck={false}
            autoComplete="off"
            placeholder="0 4 * * 1"
            onChange={(event) => onChange({ kind: "cron", expression: event.target.value })}
            className="[&_input]:font-mono [&_input]:text-small [&_input]:tracking-normal"
          />
        </Field>
      )}
    </div>
  );
}
