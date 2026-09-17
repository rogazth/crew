import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  client: { request: vi.fn(), on: vi.fn(), onReconnect: vi.fn(), openStream: vi.fn(), writeStream: vi.fn() },
}));

const { validateSchedule } = await import("./routines");

describe("validateSchedule", () => {
  it("accepts an interval", () => {
    expect(validateSchedule({ kind: "interval", minutes: 30 })).toEqual({ kind: "interval", minutes: 30 });
  });

  it("fills daily defaults and sorts days", () => {
    expect(validateSchedule({ kind: "daily", hour: 9, days: [5, 1, 1] })).toEqual({
      kind: "daily",
      hour: 9,
      minute: 0,
      days: [1, 5],
    });
  });

  it("rejects what parseSchedule would silently default", () => {
    expect(() => validateSchedule({ kind: "daily", hour: 24 })).toThrow(/hour/);
    expect(() => validateSchedule({ kind: "interval", minutes: 0 })).toThrow(/minutes/);
    expect(() => validateSchedule({ kind: "weekly" })).toThrow(/schedule/);
    expect(() => validateSchedule("daily")).toThrow(/schedule/);
  });
});

