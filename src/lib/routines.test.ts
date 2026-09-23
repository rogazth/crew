import { describe, expect, it } from "vitest";
import {
  clockOf,
  describeSchedule,
  fromRow,
  newRoutineDraft,
  nextRun,
  parseRuns,
  parseSchedule,
  pushRun,
  summarize,
  toDraft,
  triggerOf,
  validateSchedule,
  withTrigger,
  MAX_RUNS,
  type RoutineRow,
  type RoutineRun,
  type Schedule,
  type TriggerId,
} from "./routines";

/** Local wall clock, because a routine is set in the user's own day. */
const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number => new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

/**
 * The cases the daemon's `next_run` answers the same way. Rust keeps a copy of
 * this table in `crates/crew-core/src/schedule.rs`; the two are the whole
 * reason the duplication is safe, so they move together or not at all.
 */
const AGREED: Array<{ what: string; schedule: Schedule; from: number; expected: number }> = [
  {
    what: "an interval counts from now, not from the hour",
    schedule: { kind: "interval", minutes: 30 },
    from: at(2026, 9, 17, 8, 13),
    expected: at(2026, 9, 17, 8, 43),
  },
  {
    what: "a daily time later today is today",
    schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
    from: at(2026, 9, 17, 8, 0),
    expected: at(2026, 9, 17, 9, 0),
  },
  {
    what: "a daily time already past is tomorrow",
    schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
    from: at(2026, 9, 17, 10, 0),
    expected: at(2026, 9, 18, 9, 0),
  },
  {
    what: "exactly on the hour is the next one, never this one",
    schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
    from: at(2026, 9, 17, 9, 0),
    expected: at(2026, 9, 18, 9, 0),
  },
  {
    what: "weekdays from a Friday afternoon is Monday",
    // 2026-09-18 is a Friday.
    schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] },
    from: at(2026, 9, 18, 15, 0),
    expected: at(2026, 9, 21, 9, 0),
  },
  {
    what: "a single weekday from the day after it is a week out",
    // Monday only, asked on Tuesday.
    schedule: { kind: "daily", hour: 9, minute: 0, days: [1] },
    from: at(2026, 9, 22, 12, 0),
    expected: at(2026, 9, 28, 9, 0),
  },
  {
    what: "a cron expression lands on its next minute",
    schedule: { kind: "cron", expression: "30 6 * * *" },
    from: at(2026, 9, 17, 8, 0),
    expected: at(2026, 9, 18, 6, 30),
  },
];

describe("nextRun", () => {
  for (const { what, schedule, from, expected } of AGREED) {
    it(what, () => {
      expect(nextRun(schedule, from)).toBe(expected);
    });
  }

  it("answers null for a cron nothing can match", () => {
    expect(nextRun({ kind: "cron", expression: "not a cron" })).toBeNull();
  });

  it("gives up a week and a day out when no listed day exists", () => {
    // Day 9 is no weekday; parseSchedule lets a stray number through.
    const schedule = parseSchedule('{"kind":"daily","hour":9,"minute":0,"days":[9]}');
    expect(nextRun(schedule, at(2026, 9, 17, 8, 0))).toBe(at(2026, 9, 25, 9, 0));
  });

  it("never answers with a time that has already passed", () => {
    const from = at(2026, 9, 17, 23, 59);
    for (const { schedule } of AGREED) {
      const next = nextRun(schedule, from);
      expect(next === null || next > from).toBe(true);
    }
  });
});

describe("validateSchedule", () => {
  it("takes what the editor and the agents both send", () => {
    expect(validateSchedule({ kind: "interval", minutes: 30 })).toEqual({
      kind: "interval",
      minutes: 30,
    });
    expect(validateSchedule({ kind: "daily", hour: 9 })).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      days: [],
    });
    expect(validateSchedule({ kind: "cron", expression: " 0 9 * * 1 " })).toEqual({
      kind: "cron",
      expression: "0 9 * * 1",
    });
  });

  it("sorts and dedupes the days, so two spellings of Monday are one", () => {
    const schedule = validateSchedule({ kind: "daily", hour: 9, minute: 0, days: [5, 1, 1] });
    expect(schedule).toEqual({ kind: "daily", hour: 9, minute: 0, days: [1, 5] });
  });

  // An agent writes these, so the message is the documentation it gets back.
  it("says what it wanted when it refuses", () => {
    expect(() => validateSchedule({ kind: "interval", minutes: 0 })).toThrow(/at least 1/);
    expect(() => validateSchedule({ kind: "daily", hour: 24 })).toThrow(/0-23/);
    expect(() => validateSchedule({ kind: "daily", hour: 9, minute: 60 })).toThrow(/0-59/);
    expect(() => validateSchedule({ kind: "daily", hour: 9, days: [7] })).toThrow(/0-6/);
    expect(() => validateSchedule({ kind: "cron", expression: "nope" })).toThrow(/five cron fields/);
    expect(() => validateSchedule({ kind: "weekly" })).toThrow(/interval/);
    expect(() => validateSchedule("daily")).toThrow(/interval/);
  });

  it("refuses a cron expression that is not text", () => {
    expect(() => validateSchedule({ kind: "cron", expression: 5 })).toThrow(/five cron fields/);
    expect(() => validateSchedule({ kind: "cron" })).toThrow(/five cron fields/);
  });

  it("refuses days that are not a list", () => {
    expect(() => validateSchedule({ kind: "daily", hour: 9, days: "mon" })).toThrow(/0-6/);
  });

  it("refuses a fraction of a minute", () => {
    expect(() => validateSchedule({ kind: "interval", minutes: 1.5 })).toThrow();
  });
});

describe("parseSchedule", () => {
  it("reads back what the column holds", () => {
    expect(parseSchedule('{"kind":"interval","minutes":45}')).toEqual({
      kind: "interval",
      minutes: 45,
    });
  });

  // A row we cannot read still has to produce a schedule: the alternative is a
  // routine that exists and can never fire.
  it("falls back to the app's default rather than to nothing", () => {
    const fallback = { kind: "daily", hour: 9, minute: 0, days: [] };
    expect(parseSchedule("{oh no")).toEqual(fallback);
    expect(parseSchedule('{"kind":"interval","minutes":0}')).toEqual(fallback);
    expect(parseSchedule('{"kind":"cron","expression":"nope"}')).toEqual(fallback);
    expect(parseSchedule("[]")).toEqual(fallback);
  });

  it("reads back a valid cron", () => {
    expect(parseSchedule('{"kind":"cron","expression":"*/5 * * * *"}')).toEqual({
      kind: "cron",
      expression: "*/5 * * * *",
    });
  });

  it("treats days that are not a list as every day", () => {
    expect(parseSchedule('{"kind":"daily","hour":7,"minute":30,"days":"mon"}')).toEqual({
      kind: "daily",
      hour: 7,
      minute: 30,
      days: [],
    });
  });

  it("drops a day that is not a number instead of the whole schedule", () => {
    expect(parseSchedule('{"kind":"daily","hour":9,"minute":0,"days":[1,"tue",3]}')).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      days: [1, 3],
    });
  });
});

describe("describeSchedule", () => {
  it("says hours as hours", () => {
    expect(describeSchedule({ kind: "interval", minutes: 30 })).toBe("Every 30 minutes");
    expect(describeSchedule({ kind: "interval", minutes: 60 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", minutes: 180 })).toBe("Every 3 hours");
  });

  it("names the day pattern a person would name", () => {
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0, days: [] })).toBe(
      "Every day at 09:00",
    );
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 5, days: [1, 2, 3, 4, 5] })).toBe(
      "Weekdays at 09:05",
    );
    expect(describeSchedule({ kind: "daily", hour: 18, minute: 30, days: [0, 6] })).toBe(
      "Weekends at 18:30",
    );
    expect(describeSchedule({ kind: "daily", hour: 9, minute: 0, days: [2, 4] })).toBe(
      "Tue, Thu at 09:00",
    );
  });

  it("says every day for all seven of them", () => {
    expect(describeSchedule({ kind: "daily", hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] })).toBe(
      "Every day at 07:00",
    );
  });

  it("shows a cron as itself, because nothing shorter is true", () => {
    expect(describeSchedule({ kind: "cron", expression: "0 9 * * 1" })).toBe("Cron 0 9 * * 1");
  });
});

describe("clockOf", () => {
  it("has a clock only for a daily schedule", () => {
    expect(clockOf({ kind: "daily", hour: 7, minute: 5, days: [] })).toBe("07:05");
    expect(clockOf({ kind: "interval", minutes: 30 })).toBe("");
    expect(clockOf({ kind: "cron", expression: "0 9 * * 1" })).toBe("");
  });
});

describe("newRoutineDraft", () => {
  it("starts enabled, unsaved and every day at nine", () => {
    const draft = newRoutineDraft("s1");
    expect(draft).toEqual({
      key: expect.any(String),
      sessionId: "s1",
      name: "",
      enabled: true,
      prompt: "",
      schedule: { kind: "daily", hour: 9, minute: 0, days: [] },
      runs: [],
    });
    expect(draft.id).toBeUndefined();
  });

  it("gives every draft its own key", () => {
    expect(newRoutineDraft("s1").key).not.toBe(newRoutineDraft("s1").key);
  });
});

describe("triggerOf and withTrigger", () => {
  it("falls back to every day for a trigger it does not know, keeping the clock", () => {
    const daily: Schedule = { kind: "daily", hour: 18, minute: 45, days: [3] };
    expect(withTrigger(daily, "monthly" as TriggerId)).toEqual({ kind: "daily", hour: 18, minute: 45, days: [] });
    expect(withTrigger({ kind: "interval", minutes: 30 }, "monthly" as TriggerId)).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      days: [],
    });
  });

  it("round-trips every trigger the editor offers", () => {
    const schedules: Schedule[] = [
      { kind: "interval", minutes: 30 },
      { kind: "interval", minutes: 60 },
      { kind: "interval", minutes: 180 },
      { kind: "daily", hour: 9, minute: 0, days: [] },
      { kind: "daily", hour: 9, minute: 0, days: [1] },
      { kind: "cron", expression: "0 9 * * 1" },
    ];
    for (const schedule of schedules) {
      expect(withTrigger(schedule, triggerOf(schedule)).kind).toBe(schedule.kind);
    }
  });

  it("keeps the clock when the new shape has one", () => {
    const daily: Schedule = { kind: "daily", hour: 18, minute: 45, days: [] };
    expect(withTrigger(daily, "weekly")).toEqual({
      kind: "daily",
      hour: 18,
      minute: 45,
      days: [1],
    });
  });

  it("does not carry a clock onto something that has none", () => {
    const daily: Schedule = { kind: "daily", hour: 18, minute: 45, days: [] };
    expect(withTrigger(daily, "hourly")).toEqual({ kind: "interval", minutes: 60 });
  });
});

describe("the run history", () => {
  const run = (id: string): RoutineRun => ({
    id,
    startedAt: 1,
    finishedAt: 2,
    status: "ok",
    trigger: "schedule",
  });

  it("puts the newest first and caps the rest", () => {
    let runs: RoutineRun[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i += 1) runs = pushRun(runs, run(`r${i}`));
    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0]!.id).toBe(`r${MAX_RUNS + 4}`);
  });

  it("replaces an entry rather than keeping both, so a run ends where it started", () => {
    const started = pushRun([], { ...run("r1"), status: "running", finishedAt: null });
    const ended = pushRun(started, run("r1"));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.status).toBe("ok");
  });

  it("drops a line it cannot read instead of the whole history", () => {
    expect(parseRuns('[{"id":"r1"},{"nope":1},"x"]')).toEqual([{ id: "r1" }]);
    expect(parseRuns("not json")).toEqual([]);
    expect(parseRuns('{"id":"r1"}')).toEqual([]);
  });
});

describe("the row on the way in", () => {
  const row: RoutineRow = {
    id: "r1",
    sessionId: "s1",
    name: "Morning digest",
    enabled: true,
    prompt: "Check the open PRs.\n\nAnd the flaky ones.",
    schedule: '{"kind":"daily","hour":9,"minute":0,"days":[1,2,3,4,5]}',
    lastRunAt: 10,
    nextRunAt: 20,
    runsJson: '[{"id":"r1","startedAt":1,"finishedAt":2,"status":"ok","trigger":"schedule"}]',
    createdBy: null,
  };

  it("parses the history and leaves the raw column behind", () => {
    const routine = fromRow(row);
    expect(routine.runs).toHaveLength(1);
    expect("runsJson" in routine).toBe(false);
  });

  it("opens in the editor with the schedule already parsed", () => {
    const draft = toDraft(fromRow(row));
    expect(draft.id).toBe("r1");
    expect(draft.schedule).toEqual({ kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] });
  });
});

describe("summarize", () => {
  it("is the first paragraph on one line", () => {
    expect(summarize("Check the open PRs.\n\nThen the flaky ones.")).toBe("Check the open PRs.");
    expect(summarize("two\nlines")).toBe("two lines");
  });

  it("ellipsises rather than cutting mid-air", () => {
    const long = "x".repeat(200);
    const short = summarize(long, 10);
    expect(short).toHaveLength(10);
    expect(short.endsWith("…")).toBe(true);
  });
});
