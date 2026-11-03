import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon, ClockIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { POPOVER, ROW_VALUE, TOKEN, TRIGGER } from "./kit";

type Props = {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  label?: string;
  /** "row": the time at a row's right end (ROW_VALUE), opening to its left. "token": a word in a sentence (TOKEN). */
  variant?: "field" | "row" | "token";
};

/** Quarter hours are what people pick; a time set some other way is kept as its own row. Minutes since midnight. */
function timesWith(at: number): number[] {
  const steps = Array.from({ length: 96 }, (_, step) => step * 15);
  return steps.includes(at) ? steps : [...steps, at].sort((a, b) => a - b);
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (at: number) => `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;

/**
 * A wall-clock time, 24-hour like the rest of the routine: a field showing
 * "09:00" that opens one scrolling list of the day's quarter hours, the
 * picked one centred. ↑/↓ pick as they go; a click, Enter or Escape closes it.
 */
export function TimePicker({ hour, minute, onChange, label = "Time", variant = "field" }: Props) {
  const row = variant === "row";
  const token = variant === "token";
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const value = hour * 60 + minute;
  const values = timesWith(value);
  const text = clock(value);

  const pick = (at: number) => onChange(Math.floor(at / 60), at % 60);

  // Opening centres the picked row; stepping with the keys keeps it in view and focused.
  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current;
    const selected = el?.querySelector<HTMLElement>("[aria-selected=true]");
    if (!el || !selected) return;
    if (el.contains(document.activeElement)) {
      selected.focus();
      selected.scrollIntoView({ block: "nearest" });
    } else {
      el.scrollTop = selected.offsetTop - (el.clientHeight - selected.offsetHeight) / 2;
    }
  }, [open, value]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const at = values.indexOf(value);
    const to =
      event.key === "ArrowDown" ? at + 1
      : event.key === "ArrowUp" ? at - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? values.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    const next = values[Math.max(0, Math.min(values.length - 1, to))];
    if (next !== undefined && next !== value) pick(next);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger aria-label={`${label}: ${text}`} className={`${token ? TOKEN : row ? ROW_VALUE : TRIGGER} tabular-nums`}>
        {!row && !token && <ClockIcon className="size-3.5 shrink-0 text-icon" />}
        {text}
        {row && <ChevronDownIcon className="size-3.5 shrink-0 text-icon" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align={row ? "end" : "start"} sideOffset={4} className="z-50">
          <Popover.Popup
            initialFocus={() => list.current?.querySelector<HTMLElement>("[aria-selected=true]") ?? true}
            onKeyDown={onKeyDown}
            className={`${POPOVER} p-1`}
          >
            <div ref={list} role="listbox" aria-label={label} className="flex h-64 w-28 flex-col gap-0.5 overflow-y-auto">
              {values.map((item) => {
                const on = item === value;
                return (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    onClick={() => {
                      pick(item);
                      setOpen(false);
                    }}
                    className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-left tabular-nums outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${
                      on ? "font-medium" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1">{clock(item)}</span>
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
