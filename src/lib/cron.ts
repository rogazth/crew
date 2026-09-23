/**
 * Five-field cron (minute hour day-of-month month day-of-week), evaluated in
 * local time like every other schedule in the app. Names, ranges, steps and
 * lists are accepted; seconds, `@yearly` and `?`/`L`/`#` are not.
 */
export type CronSpec = {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  /** Vixie's rule: with both day fields restricted, a day matching either one fires. */
  domRestricted: boolean;
  dowRestricted: boolean;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Five years of days: enough for `0 0 29 2 *` to land on a leap year. */
const SEARCH_DAYS = 1830;

/**
 * Whitespace as Rust's `char::is_whitespace` has it, which is not quite `\s`:
 * U+0085 is in and U+FEFF is out. The daemon splits the line the same way.
 */
const WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/**
 * Reads exactly what the daemon's `parse_cron` reads. `cron-parity.json` in
 * crew-core's test fixtures holds both parsers to it.
 */
export function parseCron(expression: string): CronSpec | null {
  const parts = expression
    .replace(/[A-Z]+/g, (upper) => upper.toLowerCase())
    .split(WHITESPACE)
    .filter((part) => part !== "");
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const fields = [
    parseField(minute, 0, 59),
    parseField(hour, 0, 23),
    parseField(dom, 1, 31),
    parseField(month, 1, 12, MONTHS, 1),
    parseField(dow, 0, 6, DAYS, 0),
  ];
  if (fields.some((field) => field === null)) return null;
  const [m, h, d, mo, w] = fields as number[][];
  return {
    minute: m!,
    hour: h!,
    dom: d!,
    month: mo!,
    dow: w!,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression) !== null;
}

/** First firing strictly after `from`, or null when the expression can never match. */
export function nextCron(spec: CronSpec, from: number): number | null {
  const start = new Date(from);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const cursor = new Date(start);
  for (let day = 0; day < SEARCH_DAYS; day += 1) {
    if (matchesDay(spec, cursor)) {
      const floorHour = day === 0 ? start.getHours() : 0;
      const floorMinute = day === 0 ? start.getMinutes() : 0;
      for (const hour of spec.hour) {
        if (hour < floorHour) continue;
        for (const minute of spec.minute) {
          if (hour === floorHour && minute < floorMinute) continue;
          // In the hour a clock repeats, a local time settles on its first
          // occurrence, which can be behind `from`.
          const at = new Date(cursor);
          at.setHours(hour, minute, 0, 0);
          if (at.getTime() > from) return at.getTime();
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

function matchesDay(spec: CronSpec, at: Date): boolean {
  if (!spec.month.includes(at.getMonth() + 1)) return false;
  const dom = spec.dom.includes(at.getDate());
  const dow = spec.dow.includes(at.getDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameBase = 0,
): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const slash = part.indexOf("/");
    const range = slash < 0 ? part : part.slice(0, slash);
    const step = slash < 0 ? undefined : part.slice(slash + 1);
    if (range === "" || step === "") return null;
    const by = step === undefined ? 1 : whole(step);
    if (by === null || by < 1) return null;

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const [fromText, toText, ...rest] = range.split("-");
      if (rest.length > 0 || fromText === undefined) return null;
      const parsedLo = named(fromText, names, nameBase);
      if (parsedLo === null) return null;
      lo = parsedLo;
      if (toText === undefined) {
        // `7/2` is just Sunday; `mon/2` still stops at Saturday.
        hi = step === undefined ? lo : Math.max(max, lo);
      } else {
        const parsedHi = named(toText, names, nameBase);
        if (parsedHi === null) return null;
        hi = parsedHi;
      }
    }
    // `7` is Sunday in the day-of-week field, and only there: written out, it
    // may start or end a range, as in `5-7` or `1-7`.
    const top = names === DAYS ? 7 : max;
    if (lo < min || hi > top || lo > hi) return null;
    for (let value = lo; value <= hi; value += by) values.add(names === DAYS && value === 7 ? 0 : value);
  }
  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}

function named(text: string, names: string[] | undefined, base: number): number | null {
  const index = names?.indexOf(text) ?? -1;
  if (index >= 0) return index + base;
  return whole(text);
}

/**
 * A u32 as Rust's `str::parse` reads it: an optional `+`, then decimal digits.
 * `Number` would also take "", hex, exponents and "1.0".
 */
function whole(text: string): number | null {
  if (!/^\+?[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return value <= 0xffff_ffff ? value : null;
}
