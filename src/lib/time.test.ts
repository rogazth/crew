import { describe, expect, it } from "vitest";
import { until } from "./time";

describe("until", () => {
  const now = 1_000_000_000_000;
  const MIN = 60_000;

  it("says how far off a moment is, in its largest unit", () => {
    expect(until(now + 12 * MIN, now)).toBe("in 12m");
    expect(until(now + 3 * 60 * MIN, now)).toBe("in 3h");
    expect(until(now + 50 * 60 * MIN, now)).toBe("in 2d");
  });

  it("calls a moment that has come due", () => {
    expect(until(now + 30_000, now)).toBe("due");
    expect(until(now - MIN, now)).toBe("due");
  });
});
