import { afterEach, describe, expect, it, vi } from "vitest";
import { clock, dayLabel, duration, elapsed } from "./time";

// Local wall-clock dates, so calendar-day math holds in any timezone.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const weekday = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(ms);

afterEach(() => {
  vi.useRealTimers();
});

describe("clock", () => {
  it("shows the hour and minutes, not the date", () => {
    const label = clock(at(2026, 3, 3, 17, 7));
    expect(label).toContain("07");
    expect(label).not.toContain("2026");
  });
});

describe("dayLabel", () => {
  const now = at(2026, 9, 23, 15, 0);

  it("calls anything since midnight today", () => {
    const early = at(2026, 9, 23, 0, 5);
    expect(dayLabel(early, now)).toBe(`Today ${clock(early)}`);
    expect(dayLabel(now, now)).toBe(`Today ${clock(now)}`);
  });

  it("calls anything on the previous calendar day yesterday, even minutes ago", () => {
    const lateLastNight = at(2026, 9, 22, 23, 55);
    expect(dayLabel(lateLastNight, at(2026, 9, 23, 0, 5))).toBe(`Yesterday ${clock(lateLastNight)}`);
    const morning = at(2026, 9, 22, 8, 0);
    expect(dayLabel(morning, now)).toBe(`Yesterday ${clock(morning)}`);
  });

  it("names the weekday within the last week", () => {
    const twoDays = at(2026, 9, 21, 9, 30);
    const sixDays = at(2026, 9, 17, 9, 30);
    expect(dayLabel(twoDays, now)).toBe(`${weekday(twoDays)} ${clock(twoDays)}`);
    expect(dayLabel(sixDays, now)).toBe(`${weekday(sixDays)} ${clock(sixDays)}`);
  });

  it("shows the month and day, without the year, from a week back in the same year", () => {
    const weekAgo = at(2026, 9, 16, 9, 30);
    const label = dayLabel(weekAgo, now);
    expect(label.startsWith(weekday(weekAgo))).toBe(false);
    expect(label).toContain("16");
    expect(label).not.toContain("2026");
    expect(label.endsWith(clock(weekAgo))).toBe(true);
  });

  it("adds the year for an earlier year", () => {
    const lastYear = at(2025, 12, 1, 9, 30);
    const label = dayLabel(lastYear, now);
    expect(label).toContain("2025");
    expect(label.endsWith(clock(lastYear))).toBe(true);
  });

  it("counts calendar days across a daylight-saving change", () => {
    const beforeShift = at(2026, 3, 8, 1, 0);
    expect(dayLabel(beforeShift, at(2026, 3, 9, 1, 0))).toBe(`Yesterday ${clock(beforeShift)}`);
    const beforeFallBack = at(2026, 11, 1, 1, 0);
    expect(dayLabel(beforeFallBack, at(2026, 11, 2, 1, 0))).toBe(`Yesterday ${clock(beforeFallBack)}`);
  });

  it("measures against the current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const morning = at(2026, 9, 23, 9, 0);
    expect(dayLabel(morning)).toBe(`Today ${clock(morning)}`);
  });
});

describe("duration", () => {
  it("never says less than one second", () => {
    expect(duration(0)).toBe("1s");
    expect(duration(400)).toBe("1s");
    expect(duration(-5000)).toBe("1s");
  });

  it("rounds to whole seconds", () => {
    expect(duration(1_499)).toBe("1s");
    expect(duration(1_500)).toBe("2s");
    expect(duration(59_000)).toBe("59s");
  });

  it("shows minutes and seconds, dropping zero seconds", () => {
    expect(duration(59_600)).toBe("1m");
    expect(duration(192_000)).toBe("3m 12s");
    expect(duration(120_000)).toBe("2m");
  });

  it("shows hours and minutes past the hour, dropping the seconds", () => {
    expect(duration(3_600_000)).toBe("1h");
    expect(duration(3_612_000)).toBe("1h");
    expect(duration(3_840_000)).toBe("1h 4m");
    expect(duration(26 * 3_600_000)).toBe("26h");
  });
});

describe("elapsed", () => {
  const now = at(2026, 9, 23, 15, 0);
  const ago = (ms: number) => now - ms;

  it("says now under a minute, and for a time in the future", () => {
    expect(elapsed(ago(0), now)).toBe("now");
    expect(elapsed(ago(59_999), now)).toBe("now");
    expect(elapsed(now + 60_000, now)).toBe("now");
  });

  it("counts whole minutes under an hour", () => {
    expect(elapsed(ago(60_000), now)).toBe("1m");
    expect(elapsed(ago(4 * 60_000 + 59_000), now)).toBe("4m");
    expect(elapsed(ago(59 * 60_000), now)).toBe("59m");
  });

  it("counts hours and minutes under a day", () => {
    expect(elapsed(ago(60 * 60_000), now)).toBe("1h");
    expect(elapsed(ago(139 * 60_000), now)).toBe("2h 19m");
    expect(elapsed(ago(23 * 3_600_000 + 59 * 60_000), now)).toBe("23h 59m");
  });

  it("counts whole days from a day on", () => {
    expect(elapsed(ago(24 * 3_600_000), now)).toBe("1d");
    expect(elapsed(ago(47 * 3_600_000), now)).toBe("1d");
    expect(elapsed(ago(72 * 3_600_000), now)).toBe("3d");
  });

  it("measures against the current time by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(elapsed(ago(5 * 60_000))).toBe("5m");
  });
});
