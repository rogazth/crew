import { describe, expect, it } from "vitest";
import type { PlanUsage, UsageSnapshot } from "./protocol";
import { axisTop, crossings, mergeSnapshots, paceOf, runsOutIn, stackHeights, tokenDays, windowOf } from "./usageData";

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

describe("axisTop", () => {
  it("is a round number a little above the peak, whatever its size", () => {
    expect(axisTop(9_100_000)).toBe(15_000_000);
    expect(axisTop(1_051_000_000)).toBe(1_500_000_000);
    expect(axisTop(0)).toBe(1_000_000);
  });
});

const tokens = (provider: string, day: string, model: string, input: number) => ({ provider, day, model, input, output: 0, cacheWrite: 0, cacheRead: 0 });
const localDayOf = (ms: number) => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};

describe("tokenDays", () => {
  it("is the days kept, ending today, with the models of each", () => {
    const today = localDayOf(NOW);
    const days = tokenDays([tokens("claude", today, "opus", 5), tokens("claude", today, "haiku", 1), tokens("claude", "2000-01-01", "opus", 9)], NOW)!;
    expect(days).toHaveLength(30);
    expect(days.at(-1)!.day).toBe(today);
    expect(days.at(-1)!.models.map((model) => model.model)).toEqual(["opus", "haiku"]);
    expect(days.slice(0, -1).every((day) => day.models.length === 0)).toBe(true);
  });

  it("is none when nothing in those days was spent", () => {
    expect(tokenDays([], NOW)).toBeNull();
    expect(tokenDays([tokens("claude", "2000-01-01", "opus", 9)], NOW)).toBeNull();
  });
});

describe("stackHeights", () => {
  const counts = { input: 0, output: 1, cacheWrite: 20, cacheRead: 979 };
  const order = ["output", "input", "cacheWrite", "cacheRead"] as const;

  it("lifts a small part to where it shows and takes it from the largest, keeping the bar's height", () => {
    const parts = stackHeights(counts, 1000, 72, [...order]);
    expect(parts.map((part) => part.key)).toEqual(["output", "cacheWrite", "cacheRead"]);
    expect(parts[0]!.height).toBe(2);
    const drawn = parts.reduce((sum, part) => sum + part.height, 0) + parts.length - 1;
    expect(drawn).toBeCloseTo(72);
  });

  it("leaves out a part too small to matter and draws nothing for no tokens", () => {
    const parts = stackHeights({ input: 1, output: 0, cacheWrite: 0, cacheRead: 99_999 }, 100_000, 72, [...order]);
    expect(parts.map((part) => part.key)).toEqual(["cacheRead"]);
    expect(stackHeights({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, 1000, 72, [...order])).toEqual([]);
  });
});

describe("mergeSnapshots", () => {
  it("adds up what each machine's logs spent, but takes an account-wide count once, on the provider's newest reading", () => {
    const today = localDayOf(NOW);
    const merged = mergeSnapshots(
      [
        { readings: [plan({ account: "old@x", updatedAt: NOW - 1000 }), plan({ account: "new@x", updatedAt: NOW })], tokens: [tokens("claude", today, "opus", 5), tokens("cursor", today, "auto", 7)] },
        { readings: [plan({ provider: "cursor", account: "c@x", updatedAt: NOW })], tokens: [tokens("claude", today, "opus", 2), tokens("cursor", today, "auto", 7)] },
      ],
      NOW,
    );
    const of = (account: string) => merged.find((reading) => reading.account === account)!;
    expect(of("new@x").tokenDays!.at(-1)!.models[0]!.input).toBe(7);
    expect(of("old@x").tokenDays).toBeNull();
    expect(of("c@x").tokenDays!.at(-1)!.models[0]!.input).toBe(7);
  });

  it("takes a machine on an older build as having spent nothing", () => {
    const old = { readings: [plan()] } as unknown as Parameters<typeof mergeSnapshots>[0] extends Iterable<infer S> ? S : never;
    expect(mergeSnapshots([old], NOW)[0]!.tokenDays).toBeNull();
  });

  it("keeps the latest reading of an account read on two machines", () => {
    const mac: UsageSnapshot = {
      readings: [plan({ updatedAt: NOW - 30 * MIN })],
      tokens: [],
    };
    const box: UsageSnapshot = {
      readings: [plan({ updatedAt: NOW - 5 * MIN, windows: [{ id: "five_hour", label: "5 hours", usedPercent: 70, windowMinutes: 300 }] })],
      tokens: [],
    };
    const merged = mergeSnapshots([mac, box], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.windows[0]!.used).toBe(70);
  });

  it("keeps different accounts and providers apart, newest first, and carries opencode tokens", () => {
    const merged = mergeSnapshots(
      [
        {
          readings: [
            plan({ account: "other@example.com", updatedAt: NOW - 60 * MIN }),
            { provider: "opencode", windows: [], tokens: 1200, cost: 0.5, updatedAt: NOW, source: "cli" },
          ],
          tokens: [],
        },
        { readings: [plan()], tokens: [] },
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

describe("paceOf", () => {
  it("measures the share used against an even spend of the window", () => {
    // Two of five hours gone: an even pace stands at 40%.
    const under = paceOf({ id: "a", label: "a", used: 25, length: 300, resetsIn: 180 })!;
    expect(under.expected).toBeCloseTo(40);
    expect(under.reserve).toBeCloseTo(15);
    expect(under.runsOutIn).toBeNull();
    const over = paceOf({ id: "a", label: "a", used: 60, length: 300, resetsIn: 180 })!;
    expect(over.reserve).toBeCloseTo(-20);
    expect(over.runsOutIn).toBeCloseTo(80);
  });

  it("is unknown without a length or a reset", () => {
    expect(paceOf({ id: "a", label: "a", used: 10, length: null, resetsIn: 60 })).toBeNull();
    expect(paceOf({ id: "a", label: "a", used: 10, length: 300, resetsIn: null })).toBeNull();
  });
});

describe("crossings", () => {
  const at = (used: number) => mergeSnapshots([{ readings: [plan({ windows: [{ id: "five_hour", label: "5 hours", usedPercent: used }] })], tokens: [] }], NOW);
  it("learns on the first look, tells once on a crossing, and again after a reset", () => {
    const first = crossings(at(95), null, 90);
    expect(first.fresh).toHaveLength(0);
    expect(crossings(at(96), first.look, 90).fresh).toHaveLength(0);
    const low = crossings(at(20), first.look, 90);
    const again = crossings(at(91), low.look, 90);
    expect(again.fresh).toHaveLength(1);
  });
  it("tells when a window climbs past it", () => {
    const low = crossings(at(50), null, 90);
    expect(crossings(at(92), low.look, 90).fresh).toHaveLength(1);
  });
  it("only learns a window that first appears already past it", () => {
    const first = crossings(at(50), null, 90);
    const other = (used: number) =>
      mergeSnapshots([{ readings: [plan({ account: "b@x", windows: [{ id: "five_hour", label: "5 hours", usedPercent: used }] })], tokens: [] }], NOW);
    const both = [...at(50), ...other(95)];
    const arrived = crossings(both, first.look, 90);
    expect(arrived.fresh).toHaveLength(0);
    expect(crossings([...at(50), ...other(96)], arrived.look, 90).fresh).toHaveLength(0);
  });
});
