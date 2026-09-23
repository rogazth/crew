import { afterEach, describe, expect, it, vi } from "vitest";
import { TRIGGERS, type Schedule } from "./routines";
import { KEEP, WEEK_ORDER, atTime, pickTrigger, runOutlook, toggleDay, triggerMenu } from "./routineTrigger";

const daily = (days: number[] = [], hour = 9, minute = 0): Schedule => ({ kind: "daily", hour, minute, days });
const at = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

describe("WEEK_ORDER", () => {
  it("reads Monday first while keeping Date#getDay numbers", () => {
    expect(WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("triggerMenu", () => {
  it("lists the presets and selects the schedule's own", () => {
    const menu = triggerMenu({ kind: "interval", minutes: 180 });
    expect(menu.value).toBe("3h");
    expect(menu.items).toEqual(TRIGGERS.map((item) => ({ value: item.id, label: item.label })));
  });

  it("leads with an interval no preset spells, and selects it", () => {
    const menu = triggerMenu({ kind: "interval", minutes: 45 });
    expect(menu.value).toBe(KEEP);
    expect(menu.items[0]).toEqual({ value: KEEP, label: "Every 45 minutes" });
    expect(menu.items).toHaveLength(TRIGGERS.length + 1);
  });

  it("tells weekly from daily by whether days are set", () => {
    expect(triggerMenu(daily()).value).toBe("daily");
    expect(triggerMenu(daily([1])).value).toBe("weekly");
    expect(triggerMenu({ kind: "cron", expression: "0 9 * * 1" }).value).toBe("cron");
  });
});

describe("pickTrigger", () => {
  it("switches to the picked preset", () => {
    expect(pickTrigger({ kind: "interval", minutes: 30 }, "cron")).toEqual({ kind: "cron", expression: "0 9 * * 1" });
  });

  it("keeps the time when moving between daily and weekly", () => {
    expect(pickTrigger(daily([], 7, 30), "weekly")).toEqual(daily([1], 7, 30));
  });

  it("changes nothing for the kept interval or an empty pick", () => {
    expect(pickTrigger({ kind: "interval", minutes: 45 }, KEEP)).toBeNull();
    expect(pickTrigger(daily(), null)).toBeNull();
    expect(pickTrigger(daily(), "")).toBeNull();
  });
});

describe("atTime", () => {
  it("moves a daily schedule to the typed time", () => {
    expect(atTime(daily([2]), "18:45")).toEqual(daily([2], 18, 45));
  });

  it("ignores a cleared or partial time", () => {
    expect(atTime(daily(), "")).toBeNull();
    expect(atTime(daily(), "18")).toBeNull();
    expect(atTime(daily(), "ab:cd")).toBeNull();
  });

  it("does nothing for a schedule without a time of day", () => {
    expect(atTime({ kind: "interval", minutes: 30 }, "10:00")).toBeNull();
  });
});

describe("toggleDay", () => {
  it("adds and removes a day", () => {
    expect(toggleDay(daily([1]), 3)).toEqual(daily([1, 3]));
    expect(toggleDay(daily([1, 3]), 1)).toEqual(daily([3]));
  });

  it("refuses to drop the last day, which would never fire", () => {
    expect(toggleDay(daily([1]), 1)).toBeNull();
  });

  it("does nothing for a schedule without days", () => {
    expect(toggleDay({ kind: "cron", expression: "0 9 * * 1" }, 1)).toBeNull();
  });
});

describe("runOutlook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the next run of a valid schedule", () => {
    const from = at(3, 2, 8);
    expect(runOutlook(daily(), from)).toEqual({ valid: true, next: at(3, 2, 9) });
    expect(runOutlook({ kind: "interval", minutes: 30 }, from)).toEqual({ valid: true, next: from + 30 * 60_000 });
  });

  it("marks a malformed cron invalid, with no next run", () => {
    expect(runOutlook({ kind: "cron", expression: "every day" }, 0)).toEqual({ valid: false, next: null });
  });

  it("keeps a valid cron that can never match valid, with no next run", () => {
    expect(runOutlook({ kind: "cron", expression: "0 0 31 2 *" }, at(1, 1, 0))).toEqual({ valid: true, next: null });
  });

  it("counts from now by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(6, 1, 12));
    expect(runOutlook({ kind: "interval", minutes: 60 })).toEqual({ valid: true, next: at(6, 1, 13) });
  });
});
