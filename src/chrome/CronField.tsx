// A cron expression as one masked input: it takes only what cron writes
// (digits, `*`, `/`, `,`, `-`) and single spaces between at most five
// fields (a character the field can't take opens the next one), and greys in the fields still to come, so the shape is always in
// view and a space is all it takes to move on.
import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";

const FIELDS = 5;

/** The largest number each field takes: minute, hour, day of month, month, day of week. */
const MAX = [59, 23, 31, 12, 7];

const ITEM = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/;
const ITEM_START = /^(?:(?:\*|\d+(?:-\d*)?)(?:\/\d*)?)?$/;

/** Whether a field is whole: every list item a `*`, a number or a range, with or without a step. */
const whole = (field: string) => field.split(",").every((item) => ITEM.test(item));

/** Whether `field` can still become field `at`: its list items whole but the last, its numbers in range. */
function fits(field: string, at: number): boolean {
  const items = field.split(",");
  const last = items.pop()!;
  if (!items.every((item) => ITEM.test(item)) || !ITEM_START.test(last)) return false;
  const max = MAX[at] ?? Infinity;
  return (field.match(/\d+/g) ?? []).every((n) => n.length <= String(max).length && Number(n) <= max);
}

/**
 * What the mask lets through: cron's characters, any run of whitespace as one space, nothing before the first field.
 * A character the field can't take opens the next one when the field is whole, so `*****` reads as `* * * * *` and
 * `123` as `12 3`; otherwise it's dropped.
 */
function clean(text: string): string {
  const fields = [""];
  for (const char of text.replace(/\s+/g, " ").replace(/[^0-9*/,\- ]/g, "")) {
    const at = fields.length - 1;
    const field = fields[at]!;
    if (char === " ") {
      if (field !== "") fields.push("");
    } else if (fits(field + char, at)) fields[at] = field + char;
    else if (whole(field) && fits(char, at + 1)) fields.push(char);
  }
  return fields.join(" ");
}

/** The fields still to come, as `*`s: the one being started when the text ends on a space, then the rest. */
function ghostOf(text: string): string {
  const parts = text.split(" ");
  const started = parts[parts.length - 1] === "" ? "*" : "";
  return started + " *".repeat(FIELDS - parts.length);
}

export function CronField({ value, invalid, onChange }: { value: string; invalid: boolean; onChange: (expression: string) => void }) {
  // Its own text, so a trailing space keeps its place; read again only when the expression changes from outside.
  const [text, setText] = useState(() => clean(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value.trim() !== text.trim()) setText(clean(value));
  }
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  // A dropped character moves the caret back with it, not to the end.
  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [text]);

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    const next = clean(raw);
    // A sixth field doesn't exist: the keystroke that would start one is refused.
    if (next.split(" ").length > FIELDS) {
      const at = Math.max(0, (event.target.selectionStart ?? raw.length) - (raw.length - text.length));
      event.target.value = text;
      event.target.setSelectionRange(at, at);
      return;
    }
    caret.current = clean(raw.slice(0, event.target.selectionStart ?? raw.length)).length;
    setText(next);
    const expression = next.trim();
    setSeen(expression);
    onChange(expression);
  };

  return (
    <label
      aria-invalid={invalid}
      className="flex h-5 cursor-text items-center rounded-sm px-1 font-mono text-[12.5px] whitespace-pre transition-colors hover:bg-hover focus-within:bg-hover aria-invalid:not-focus-within:text-danger"
    >
      <input
        ref={input}
        aria-label="Cron expression"
        title="minute hour day-of-month month day-of-week"
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={change}
        className="min-w-px bg-transparent outline-none [field-sizing:content]"
      />
      <span aria-hidden className="pointer-events-none text-placeholder">
        {ghostOf(text)}
      </span>
    </label>
  );
}
