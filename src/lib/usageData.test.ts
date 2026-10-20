import { describe, expect, it } from "vitest";
import type { PlanUsage, UsageSnapshot } from "./protocol";
import { crossings, mergeSnapshots, runsOutIn, weekOf, windowOf } from "./usageData";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const MIN = 60_000;

const plan = (patch: Partial<PlanUsage> = {}): PlanUsage => ({
  provider: "claude",
  account: "me@example.com",
  plan: "Max",
  windows: [{ id: "five_hour", label: "5 hours", usedPercent: 40.4, windowMinutes: 300, resetsAt: NOW + 60 * MIN }],
  updatedAt: NOW - 10 * MIN,
  source: "stream",
  ...patch,
});

describe("windowOf", () => {
  it("maps percent, length and the time left from resetsAt", () => {
    const w = windowOf(plan().windows[0]!, NOW);
    expect(w).toMatchObject({ used: 40, length: 300, resetsIn: 60 });
  });
  it("leaves length and reset unknown, and clamps", () => {
    const w = windowOf({ id: "cycle", label: "Monthly", usedPercent: 130 }, NOW);
    expect(w).toMatchObject({ used: 100, length: null, resetsIn: null });
    expect(runsOutIn(w)).toBeNull();
  });
});

describe("weekOf", () => {
  it("is seven days ending today, each day's highest", () => {
    const week = weekOf(
      [
        { provider: "claude", day: "2026-10-19", percent: 20 },
        { provider: "claude", day: "2026-10-19", percent: 35 },
        { provider: "claude", day: "2026-10-15", percent: 10 },
      ],
      NOW,
    );
    expect(week.map((d) => d.day)).toEqual([
      "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19",
    ]);
    expect(week.map((d) => d.percent)).toEqual([0, 0, 10, 0, 0, 0, 35]);
  });
});

describe("mergeSnapshots", () => {
  it("keeps the latest reading of an account read on two machines and the higher day", () => {
    const mac: UsageSnapshot = {
      readings: [plan({ updatedAt: NOW - 30 * MIN })],
      history: [{ provider: "claude", account: "me@example.com", day: "2026-10-19", percent: 20 }],
    };
    const box: UsageSnapshot = {
      readings: [plan({ updatedAt: NOW - 5 * MIN, windows: [{ id: "five_hour", label: "5 hours", usedPercent: 70, windowMinutes: 300 }] })],
      history: [{ provider: "claude", account: "me@example.com", day: "2026-10-19", percent: 55 }],
    };
    const merged = mergeSnapshots([mac, box], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.windows[0]!.used).toBe(70);
    expect(merged[0]!.history.at(-1)!.percent).toBe(55);
  });

  it("keeps different accounts and providers apart, newest first, and carries opencode tokens", () => {
    const merged = mergeSnapshots(
      [
        {
          readings: [
            plan({ account: "other@example.com", updatedAt: NOW - 60 * MIN }),
            { provider: "opencode", windows: [], tokens: 1200, cost: 0.5, updatedAt: NOW, source: "cli" },
          ],
          history: [],
        },
        { readings: [plan()], history: [] },
      ],
      NOW,
    );
    expect(merged.map((r) => [r.provider, r.account])).toEqual([
      ["opencode", null],
      ["claude", "me@example.com"],
      ["claude", "other@example.com"],
    ]);
    expect(merged[0]).toMatchObject({ name: "OpenCode", plan: null, tokens: 1200, cost: 0.5 });
  });
});

describe("runsOutIn", () => {
  it("projects the pace, and is null when it lasts", () => {
    expect(runsOutIn({ id: "a", label: "a", used: 80, length: 300, resetsIn: 100 })).toBeCloseTo(50);
    expect(runsOutIn({ id: "a", label: "a", used: 10, length: 300, resetsIn: 100 })).toBeNull();
  });
});

describe("crossings", () => {
  const at = (used: number) => mergeSnapshots([{ readings: [plan({ windows: [{ id: "five_hour", label: "5 hours", usedPercent: used }] })], history: [] }], NOW);
  it("learns on the first look, tells once on a crossing, and again after a reset", () => {
    const first = crossings(at(95), null, 90);
    expect(first.fresh).toHaveLength(0);
    expect(crossings(at(96), first.over, 90).fresh).toHaveLength(0);
    const low = crossings(at(20), first.over, 90);
    const again = crossings(at(91), low.over, 90);
    expect(again.fresh).toHaveLength(1);
  });
  it("tells when a window climbs past it", () => {
    const low = crossings(at(50), null, 90);
    expect(crossings(at(92), low.over, 90).fresh).toHaveLength(1);
  });
});
