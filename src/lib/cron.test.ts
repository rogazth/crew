import { describe, expect, it } from "vitest";
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

  it("crosses the year boundary", () => {
    expect(next("0 0 1 1 *", at(2025, 12, 31, 23, 59))).toBe(at(2026, 1, 1));
  });
});
