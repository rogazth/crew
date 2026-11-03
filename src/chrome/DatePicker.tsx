import { Popover } from "@base-ui/react/popover";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNow } from "../hooks/useNow";
import { POPOVER, ROW_VALUE, TOKEN, TRIGGER } from "./kit";

type Props = {
  /** Any moment on the picked day, epoch ms. */
  value: number;
  /** Local midnight of the day picked; the caller puts its own time of day back on. */
  onChange: (day: Date) => void;
  /** Only today and later can be picked. */
  future?: boolean;
  label?: string;
  /** "row": the day at a row's right end (ROW_VALUE), opening to its left. "token": a word in a sentence (TOKEN). */
  variant?: "field" | "row" | "token";
};

const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

/** Two letters a column, Monday first like the routine's weekday row. Jan 1 2024 was a Monday. */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, 1 + i)).slice(0, 2),
);

const dayOf = (at: number | Date) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const sameDay = (a: Date, b: Date) => a.getTime() === b.getTime();

/** The same day of another month, or that month's last day when it is shorter. */
function shiftMonth(day: Date, by: number): Date {
  const last = new Date(day.getFullYear(), day.getMonth() + by + 1, 0).getDate();
  return new Date(day.getFullYear(), day.getMonth() + by, Math.min(day.getDate(), last));
}

/** Six whole weeks from the Monday on or before the 1st, so the grid never changes height. */
function weeksOf(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const back = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - back + i));
}

/**
 * A day, picked from a month grid in a popover. The arrows walk days and
 * weeks, Page Up and Page Down walk months, Home and End the week's ends;
 * Enter or a click picks and closes.
 */
export function DatePicker({ value, onChange, future = false, label = "Date", variant = "field" }: Props) {
  const row = variant === "row";
  const token = variant === "token";
  const [open, setOpen] = useState(false);
  // Read again each minute while open, so a grid left up past midnight moves its floor.
  const today = dayOf(useNow(60_000, open));
  const picked = dayOf(value);
  const floor = future ? today : null;
  /** The day the keyboard is on; its month is the one shown. */
  const [cursor, setCursor] = useState(picked);
  const grid = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const text = (picked.getFullYear() === today.getFullYear() ? DAY : DAY_YEAR).format(picked);

  // A key that moved the cursor moves focus with it, onto the button just rendered.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    grid.current?.querySelector<HTMLElement>("[data-cursor]")?.focus();
  }, [cursor]);

  const openChange = (next: boolean) => {
    // A day already past can't take focus, so a stale pick opens on the first day that can.
    if (next) setCursor(floor !== null && picked < floor ? floor : picked);
    setOpen(next);
  };

  const before = (day: Date) => floor !== null && day < floor;

  /** `focus` is for the keys; a click on the month arrows leaves focus on the arrow. */
  const move = (to: Date, focus = true) => {
    refocus.current = focus;
    setCursor(floor !== null && to < floor ? floor : to);
  };

  const pick = (day: Date) => {
    onChange(day);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    const d = cursor.getDate();
    const weekday = (cursor.getDay() + 6) % 7;
    const to =
      event.key === "ArrowLeft" ? new Date(y, m, d - 1)
      : event.key === "ArrowRight" ? new Date(y, m, d + 1)
      : event.key === "ArrowUp" ? new Date(y, m, d - 7)
      : event.key === "ArrowDown" ? new Date(y, m, d + 7)
      : event.key === "Home" ? new Date(y, m, d - weekday)
      : event.key === "End" ? new Date(y, m, d + 6 - weekday)
      : event.key === "PageUp" ? shiftMonth(cursor, -1)
      : event.key === "PageDown" ? shiftMonth(cursor, 1)
      : null;
    if (!to) return;
    event.preventDefault();
    move(to);
  };

  const month = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const canGoBack = floor === null || month > floor;

  return (
    <Popover.Root open={open} onOpenChange={openChange} modal={false}>
      <Popover.Trigger aria-label={`${label}: ${FULL.format(picked)}`} className={token ? TOKEN : row ? ROW_VALUE : TRIGGER}>
        {!row && !token && <CalendarIcon className="size-3.5 shrink-0 text-icon" />}
        {text}
        {row && <ChevronDownIcon className="size-3.5 shrink-0 text-icon" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={row ? "end" : "start"} sideOffset={4} className="z-50">
          <Popover.Popup
            initialFocus={() => grid.current?.querySelector<HTMLElement>("[data-cursor]") ?? true}
            className={`${POPOVER} w-[240px] p-2`}
          >
            <div className="flex h-8 items-center gap-1 pb-1">
              <span aria-live="polite" className="min-w-0 flex-1 truncate pl-1.5 font-medium">
                {MONTH.format(month)}
              </span>
              <NavButton label="Previous month" disabled={!canGoBack} onClick={() => move(shiftMonth(cursor, -1), false)}>
                <ChevronLeftIcon className="size-4" />
              </NavButton>
              <NavButton label="Next month" onClick={() => move(shiftMonth(cursor, 1), false)}>
                <ChevronRightIcon className="size-4" />
              </NavButton>
            </div>

            <div className="grid grid-cols-7">
              {WEEKDAYS.map((name) => (
                <span key={name} aria-hidden className="grid h-7 place-items-center text-[11px] text-text-muted">
                  {name}
                </span>
              ))}
            </div>

            {/* Only the cursor's day is in the tab order; the arrows reach the rest. */}
            <div ref={grid} role="group" aria-label={MONTH.format(month)} onKeyDown={onKeyDown} className="grid grid-cols-7">
              {weeksOf(month).map((day) => {
                const on = sameDay(day, picked);
                const here = sameDay(day, cursor);
                const outside = day.getMonth() !== month.getMonth();
                return (
                  <button
                    key={day.getTime()}
                    type="button"
                    tabIndex={here ? 0 : -1}
                    {...(here ? { "data-cursor": "" } : {})}
                    aria-label={FULL.format(day)}
                    aria-pressed={on}
                    aria-current={sameDay(day, today) ? "date" : undefined}
                    disabled={before(day)}
                    onClick={() => pick(day)}
                    className={`grid size-8 place-items-center rounded-md text-[12px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50 disabled:pointer-events-none disabled:text-placeholder disabled:opacity-50 aria-[current=date]:font-semibold ${
                      on ? "bg-accent text-inverse"
                      : outside ? "text-placeholder hover:bg-hover hover:text-text"
                      : "hover:bg-hover"
                    } ${sameDay(day, today) && !on ? "ring-1 ring-border-strong" : ""}`}
                  >
                    {day.getDate()}
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

function NavButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
