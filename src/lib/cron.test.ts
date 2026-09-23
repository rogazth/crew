import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import parity from "../../crates/crew-core/tests/fixtures/cron-parity.json";
import { isValidCron, nextCron, parseCron } from "./cron";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function next(expression: string, from: number): number | null {
  const spec = parseCron(expression);
  if (!spec) throw new Error(`invalid: ${expression}`);
  return nextCron(spec, from);
}

describe("parseCron", () => {
  it("rejects anything that is not five fields", () => {
    expect(parseCron("* * * *")).toBeNull();
    expect(parseCron("0 0 * * * *")).toBeNull();
    expect(parseCron("")).toBeNull();
  });

  it("rejects out-of-range and malformed fields", () => {
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("* 24 * * *")).toBe(false);
    expect(isValidCron("* * 0 * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false);
    expect(isValidCron("5-1 * * * *")).toBe(false);
    expect(isValidCron("a * * * *")).toBe(false);
    expect(isValidCron("*/ * * * *")).toBe(false);
    expect(isValidCron(",5 * * * *")).toBe(false);
    expect(isValidCron("1-2-3 * * * *")).toBe(false);
    expect(isValidCron("1-x * * * *")).toBe(false);
    expect(isValidCron("0 0 * * mon-xyz")).toBe(false);
  });

  it("runs a step from a single start value to the end of the field", () => {
    expect(parseCron("5/15 * * * *")?.minute).toEqual([5, 20, 35, 50]);
    expect(parseCron("0 0 * * mon/2")?.dow).toEqual([1, 3, 5]);
  });

  it("expands steps, ranges and lists", () => {
    expect(parseCron("*/15 * * * *")?.minute).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 9-11 * * *")?.hour).toEqual([9, 10, 11]);
    expect(parseCron("0,30 * * * *")?.minute).toEqual([0, 30]);
    expect(parseCron("0 0 1 */3 *")?.month).toEqual([1, 4, 7, 10]);
  });

  it("reads day and month names, and 7 as Sunday", () => {
    expect(parseCron("0 9 * * mon-fri")?.dow).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 1 jan,jul *")?.month).toEqual([1, 7]);
    expect(parseCron("0 0 * * 7")?.dow).toEqual([0]);
  });

  it("takes 7 as Sunday at either end of a day range", () => {
    expect(parseCron("0 0 * * 5-7")?.dow).toEqual([0, 5, 6]);
    expect(parseCron("0 0 * * 1-7")?.dow).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseCron("0 0 * * sun-7")?.dow).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseCron("0 0 * * 1-7/2")?.dow).toEqual([0, 1, 3, 5]);
    expect(parseCron("0 0 * * 7/2")?.dow).toEqual([0]);
    expect(parseCron("0 0 * * 7-sat")).toBeNull();
    expect(parseCron("0 7-8 * * *")?.hour).toEqual([7, 8]);
    expect(parseCron("0 0 1 7-13 *")).toBeNull();
  });
});

describe("parity with the daemon", () => {
  // crew-core's cron tests read the same table.
  it("accepts exactly the expressions the daemon's parser accepts", () => {
    expect(parity.length).toBeGreaterThan(100);
    expect(parity.filter(({ expression, valid }) => isValidCron(expression) !== valid)).toEqual([]);
  });
});

describe("nextCron", () => {
  it("fires strictly after the given moment", () => {
    // Wed Sep 3 2025, 09:00 exactly.
    expect(next("0 9 * * *", at(2025, 9, 3, 9, 0))).toBe(at(2025, 9, 4, 9, 0));
    expect(next("0 9 * * *", at(2025, 9, 3, 8, 59))).toBe(at(2025, 9, 3, 9, 0));
  });

  it("walks to the next matching weekday", () => {
    expect(next("30 7 * * mon", at(2025, 9, 3, 12, 0))).toBe(at(2025, 9, 8, 7, 30));
  });

  it("fires 7 on Sunday", () => {
    // Wed Sep 3 2025; the 7th is the Sunday after.
    expect(next("0 9 * * 7", at(2025, 9, 3, 12, 0))).toBe(at(2025, 9, 7, 9, 0));
    expect(next("0 9 * * 5-7", at(2025, 9, 6, 10, 0))).toBe(at(2025, 9, 7, 9, 0));
    expect(next("0 9 * * 5-7", at(2025, 9, 7, 10, 0))).toBe(at(2025, 9, 12, 9, 0));
    expect(next("0 9 * * 1-7", at(2025, 9, 6, 10, 0))).toBe(at(2025, 9, 7, 9, 0));
    expect(next("0 9 * * 1-7", at(2025, 9, 7, 10, 0))).toBe(at(2025, 9, 8, 9, 0));
  });

  it("takes the earliest hour and minute of a matching day", () => {
    expect(next("*/20 9,17 * * *", at(2025, 9, 3, 9, 25))).toBe(at(2025, 9, 3, 9, 40));
    expect(next("*/20 9,17 * * *", at(2025, 9, 3, 9, 45))).toBe(at(2025, 9, 3, 17, 0));
  });

  it("matches either day field when both are restricted", () => {
    // The 1st of the month or any Monday, whichever comes first.
    expect(next("0 0 1 * mon", at(2025, 9, 3, 12, 0))).toBe(at(2025, 9, 8));
    expect(next("0 0 1 * mon", at(2025, 9, 29, 12, 0))).toBe(at(2025, 10, 1));
  });

  it("reaches a leap day years out", () => {
    expect(next("0 0 29 2 *", at(2025, 9, 3))).toBe(at(2028, 2, 29));
  });

  it("answers null for a date that never comes", () => {
    expect(next("0 0 31 2 *", at(2025, 9, 3))).toBeNull();
    expect(next("0 0 30 feb *", at(2025, 9, 3))).toBeNull();
  });

  it("crosses the year boundary", () => {
    expect(next("0 0 1 1 *", at(2025, 12, 31, 23, 59))).toBe(at(2026, 1, 1));
  });
});

type Asked = { clocks: string[]; answers: Array<{ expression: string; from: number; next: number | null }> };

/**
 * A worker thread cannot change its time zone, so the clock changes are asked
 * about in a node started in Santiago, which repeats 23:00-23:59 on 4 April
 * 2026 and skips 00:00-00:59 on 6 September.
 */
function askSantiago(expressions: string[], froms: number[], clocks: number[]): Asked {
  const script = `
    const { nextCron, parseCron } = await import(${JSON.stringify(new URL("./cron.ts", import.meta.url).href)});
    const [expressions, froms, clocks] = JSON.parse(process.argv[1]);
    const answers = expressions.flatMap((expression) =>
      froms.map((from) => ({ expression, from, next: nextCron(parseCron(expression), from) })),
    );
    const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
    console.log(JSON.stringify({ clocks: clocks.map(clock), answers }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", script, JSON.stringify([expressions, froms, clocks])],
    { env: { ...process.env, TZ: "America/Santiago" }, encoding: "utf8", timeout: 10_000 },
  );
  return JSON.parse(output) as Asked;
}

describe("nextCron across a change of the clock", () => {
  // 23:30 on the Saturday, once in summer time (-03) and again in winter time (-04).
  const firstPass = Date.parse("2026-04-04T23:30:00-03:00");
  const secondPass = Date.parse("2026-04-04T23:30:00-04:00");
  const HOUR = 3_600_000;

  it("answers after the moment it was given, even from the second pass of a repeated hour", () => {
    const changes = [Date.parse("2026-04-05T00:00:00-03:00"), Date.parse("2026-09-06T00:00:00-04:00")];
    const froms = changes.flatMap((change) =>
      Array.from({ length: 73 }, (_, step) => change - 3 * HOUR + step * 5 * 60_000),
    );
    const expressions = ["* * * * *", "*/10 * * * *", "45 23 * * *", "30 23 * * *", "0 0 * * *", "30 0 * * *"];
    const asked = askSantiago(expressions, froms, [firstPass, secondPass]);

    // Both instants read 23:30 there, an hour apart: the sweep is inside a repeated hour.
    expect(secondPass - firstPass).toBe(HOUR);
    expect(asked.clocks).toEqual(["23:30", "23:30"]);
    expect(froms).toContain(secondPass);
    expect(asked.answers).toHaveLength(expressions.length * froms.length);
    expect(asked.answers.filter(({ from, next }) => next === null || next <= from)).toEqual([]);
  });
});
