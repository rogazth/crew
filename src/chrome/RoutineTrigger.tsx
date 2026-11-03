import { Popover } from "@base-ui/react/popover";
import { CheckIcon, RepeatIcon } from "lucide-react";
import type { ReactNode } from "react";
import { isValidCron } from "../lib/cron";
import { describeSchedule, nextRun, triggerOf, withTrigger, TRIGGERS, WEEKDAYS, type Schedule } from "../lib/routines";
import { dayLabel } from "../lib/time";
import { CronField } from "./CronField";
import { DatePicker } from "./DatePicker";
import { PaneCard, PaneSentence } from "./BotPaneParts";
import { PANEL, ROW, Select, TOKEN, type Option } from "./kit";
import { TimePicker } from "./TimePicker";

type Props = {
  schedule: Schedule;
  onChange: (schedule: Schedule) => void;
};

/** Weeks read Monday-first here; the stored numbers stay Date#getDay. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** A day's whole name; Jan 1 2024 was a Monday, so day n of that week is 2024-01-n (Sunday the 7th). */
const FULL_DAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });

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

  // A one-off moment is a day and a clock picked apart; each keeps the other's half, in local time.
  const pickDay = (day: Date) => {
    if (schedule.kind !== "once") return;
    const at = new Date(schedule.at);
    onChange({
      kind: "once",
      at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), at.getHours(), at.getMinutes()).getTime(),
    });
  };

  const pickClock = (hour: number, minute: number) => {
    if (schedule.kind === "daily") {
      onChange({ ...schedule, hour, minute });
    } else if (schedule.kind === "once") {
      const at = new Date(schedule.at);
      onChange({ kind: "once", at: new Date(at.getFullYear(), at.getMonth(), at.getDate(), hour, minute).getTime() });
    }
  };

  // A week with no day selected would never fire, so the last one cannot be dropped.
  const toggleDay = (day: number) => {
    if (schedule.kind !== "daily") return;
    const days = schedule.days.includes(day) ? schedule.days.filter((value) => value !== day) : [...schedule.days, day];
    if (days.length > 0) onChange({ ...schedule, days });
  };

  return (
    <div className="flex flex-col gap-2">
      <PaneCard label="Schedule">
        <PaneSentence icon={<RepeatIcon className="size-4" />} title="Schedule">
          <Select
            variant="token"
            label="Repeats"
            value={offPreset ? KEEP : trigger}
            onChange={(value) => value !== KEEP && onChange(withTrigger(schedule, value as typeof trigger))}
            options={items}
          />
          {trigger === "weekly" && schedule.kind === "daily" && (
            <>
              <Word>on</Word>
              <DaysPicker days={schedule.days} onToggle={toggleDay} />
            </>
          )}
          {schedule.kind === "once" && (
            <>
              <Word>on</Word>
              <DatePicker variant="token" value={schedule.at} future onChange={pickDay} />
            </>
          )}
          {(schedule.kind === "daily" || schedule.kind === "once") && (
            <>
              <Word>at</Word>
              <TimePicker
                variant="token"
                hour={schedule.kind === "daily" ? schedule.hour : new Date(schedule.at).getHours()}
                minute={schedule.kind === "daily" ? schedule.minute : new Date(schedule.at).getMinutes()}
                onChange={pickClock}
              />
            </>
          )}
          {schedule.kind === "cron" && (
            <CronField value={schedule.expression} invalid={!valid} onChange={(expression) => onChange({ kind: "cron", expression })} />
          )}
        </PaneSentence>
      </PaneCard>

      {/* When it next comes round, under the card; what is wrong with it, in its place. */}
      <p className="px-1 text-[12px] text-text-muted">
        {!valid ? (
          <span className="text-danger">Five fields: minute hour day-of-month month day-of-week</span>
        ) : next === null && schedule.kind === "once" ? (
          <span className="text-danger">This time has passed</span>
        ) : next === null ? (
          <span className="text-danger">This pattern never comes around</span>
        ) : (
          <>
            {schedule.kind === "once" ? "Runs" : "Next run"} {dayLabel(next)}
          </>
        )}
      </p>
    </div>
  );
}

/** The muted joining word between the sentence's controls. */
function Word({ children }: { children: ReactNode }) {
  return <span className="text-text-muted">{children}</span>;
}

/** The week's days as words: "weekdays", "weekends", "every day", or the days themselves, Monday first. */
function daysText(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((day) => set.has(day))) return "weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "weekends";
  return WEEK_ORDER.filter((day) => set.has(day))
    .map((day) => WEEKDAYS[day])
    .join(", ");
}

/** Which days a weekly routine runs on: a menu of the week, each a check that leaves the menu open. */
function DaysPicker({ days, onToggle }: { days: number[]; onToggle: (day: number) => void }) {
  const text = daysText(days);
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger aria-label={`Days: ${text}`} className={TOKEN}>
        {text}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
          <Popover.Popup initialFocus={false} className={`${PANEL} w-44`}>
            <div role="group" aria-label="Days">
              {WEEK_ORDER.map((day) => {
                const on = days.includes(day);
                return (
                  <button key={day} type="button" aria-pressed={on} onClick={() => onToggle(day)} className={`${ROW} hover:bg-hover`}>
                    <span className="min-w-0 flex-1">{FULL_DAY.format(new Date(2024, 0, day === 0 ? 7 : day))}</span>
                    {on && <CheckIcon className="size-4 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
