import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  isValidCron,
  nextCron,
  nextRun,
  parseCron,
  parseSchedule,
  summarizePrompt,
  triggerOf,
  withTrigger,
} from "./schedule";

const at = (iso: string) => new Date(iso).getTime();

describe("cron parsing", () => {
  it("takes the five ordinary fields", () => {
    expect(isValidCron("0 9 * * 1")).toBe(true);
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 0,12 1 */2 *")).toBe(true);
    expect(isValidCron("0 9-17 * * 1-5")).toBe(true);
  });

  it("rejects what is not a cron", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("0 9 * *")).toBe(false);
    expect(isValidCron("0 9 * * * *")).toBe(false);
    expect(isValidCron("60 9 * * 1")).toBe(false);
    expect(isValidCron("0 24 * * 1")).toBe(false);
    expect(isValidCron("0 9 * * 8")).toBe(false);
    expect(isValidCron("banana")).toBe(false);
  });

  it("treats 7 as Sunday, like every crontab", () => {
    expect(parseCron("0 9 * * 7")?.daysOfWeek).toEqual([0]);
  });

  it("expands a step over a range", () => {
    expect(parseCron("0 9-17/4 * * *")?.hours).toEqual([9, 13, 17]);
  });

  it("rejects a backwards range", () => {
    expect(parseCron("0 17-9 * * *")).toBeNull();
  });
});

describe("nextCron", () => {
  it("finds the next matching minute", () => {
    const spec = parseCron("30 9 * * *")!;
    const next = nextCron(spec, at("2026-03-10T08:00:00"));
    expect(new Date(next!).getHours()).toBe(9);
    expect(new Date(next!).getMinutes()).toBe(30);
  });

  it("rolls to tomorrow when today's slot has passed", () => {
    const spec = parseCron("0 9 * * *")!;
    const from = at("2026-03-10T10:00:00");
    const next = nextCron(spec, from)!;
    expect(next).toBeGreaterThan(from);
    expect(new Date(next).getDate()).toBe(11);
  });

  it("matches either day field when both are set, not both", () => {
    // The 1st of the month, or any Monday.
    const spec = parseCron("0 0 1 * 1")!;
    const next = nextCron(spec, at("2026-03-03T12:00:00"))!;
    const day = new Date(next);
    expect(day.getDate() === 1 || day.getDay() === 1).toBe(true);
  });

  it("never answers with a time at or before the one asked about", () => {
    const spec = parseCron("*/5 * * * *")!;
    const from = at("2026-03-10T10:00:00");
    expect(nextCron(spec, from)!).toBeGreaterThan(from);
  });

  it("gives up rather than looping on a cron that can never match", () => {
    // 30 February.
    const spec = parseCron("0 0 30 2 *")!;
    expect(nextCron(spec, at("2026-03-10T10:00:00"))).toBeNull();
  });
});

describe("schedules", () => {
  it("round-trips through JSON", () => {
    const schedule = { kind: "daily" as const, hour: 22, minute: 30, days: [1, 5] };
    expect(parseSchedule(JSON.stringify(schedule))).toEqual(schedule);
  });

  it("falls back to the daily default for anything unparseable", () => {
    expect(parseSchedule("not json").kind).toBe("daily");
    expect(parseSchedule(JSON.stringify({ kind: "interval", minutes: 0 })).kind).toBe("daily");
    expect(parseSchedule(JSON.stringify({ kind: "cron", expression: "nope" })).kind).toBe("daily");
  });

  it("describes itself in words", () => {
    expect(describeSchedule({ kind: "interval", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "interval", minutes: 60 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", minutes: 180 })).toBe("Every 3 hours");
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0, days: [] })).toBe("Every day at 09:00");
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5, days: [1, 2, 3, 4, 5] })).toBe(
      "Weekdays at 09:05",
    );
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0, days: [0, 6] })).toBe(
      "Weekends at 09:00",
    );
    expect(describeSchedule({ kind: "cron", expression: "0 9 * * 1" })).toBe("Cron 0 9 * * 1");
  });

  it("maps a schedule back to the trigger that made it", () => {
    expect(triggerOf({ kind: "interval", minutes: 30 })).toBe("30m");
    expect(triggerOf({ kind: "interval", minutes: 180 })).toBe("3h");
    expect(triggerOf({ kind: "daily", hour: 9, minute: 0, days: [] })).toBe("daily");
    expect(triggerOf({ kind: "daily", hour: 9, minute: 0, days: [1] })).toBe("weekly");
    expect(triggerOf({ kind: "cron", expression: "0 9 * * 1" })).toBe("cron");
  });

  it("carries the time over when switching between daily and weekly", () => {
    const daily = { kind: "daily" as const, hour: 18, minute: 45, days: [] };
    const weekly = withTrigger(daily, "weekly");
    expect(weekly).toEqual({ kind: "daily", hour: 18, minute: 45, days: [1] });
  });

  it("drops the time when switching to a shape that has none", () => {
    const daily = { kind: "daily" as const, hour: 18, minute: 45, days: [] };
    expect(withTrigger(daily, "hourly")).toEqual({ kind: "interval", minutes: 60 });
  });
});

describe("nextRun", () => {
  it("adds the interval", () => {
    const from = at("2026-03-10T10:00:00");
    expect(nextRun({ kind: "interval", minutes: 45 }, from)).toBe(from + 45 * 60_000);
  });

  it("finds today's slot when it is still ahead", () => {
    const from = at("2026-03-10T08:00:00");
    const next = new Date(nextRun({ kind: "daily", hour: 9, minute: 0, days: [] }, from)!);
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(9);
  });

  it("skips to the next allowed weekday", () => {
    // 2026-03-10 is a Tuesday; ask for Fridays only.
    const from = at("2026-03-10T10:00:00");
    const next = new Date(nextRun({ kind: "daily", hour: 9, minute: 0, days: [5] }, from)!);
    expect(next.getDay()).toBe(5);
  });

  it("answers null for a cron that can never match", () => {
    expect(nextRun({ kind: "cron", expression: "0 0 30 2 *" }, at("2026-03-10T10:00:00"))).toBeNull();
  });
});

describe("summarizePrompt", () => {
  it("takes the first paragraph and collapses whitespace", () => {
    expect(summarizePrompt("First   line\nstill first\n\nSecond paragraph")).toBe(
      "First line still first",
    );
  });

  it("truncates on a word-ish boundary with an ellipsis", () => {
    const out = summarizePrompt("word ".repeat(80), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.endsWith("…")).toBe(true);
  });
});
