import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../protocol";
import { clearSince, groupByDay, hostOf } from "./history";

const NOW = new Date(2026, 8, 23, 15, 0).getTime();

const entry = (url: string, at: number): HistoryEntry => ({
  urlKey: url,
  url,
  host: new URL(url).hostname,
  title: "",
  visitCount: 1,
  lastVisitedAt: at,
  workspaceId: null,
});

describe("groupByDay", () => {
  it("keeps the order and splits on local calendar days", () => {
    const rows = [
      entry("https://a.com", new Date(2026, 8, 23, 14, 0).getTime()),
      entry("https://b.com", new Date(2026, 8, 23, 0, 1).getTime()),
      entry("https://c.com", new Date(2026, 8, 22, 23, 59).getTime()),
      entry("https://d.com", new Date(2025, 2, 3, 9, 0).getTime()),
    ];
    const days = groupByDay(rows, NOW);
    expect(days.map((day) => day.label)).toEqual(["Today", "Yesterday", expect.stringContaining("2025")]);
    expect(days.map((day) => day.entries.map((e) => e.url))).toEqual([
      ["https://a.com", "https://b.com"],
      ["https://c.com"],
      ["https://d.com"],
    ]);
  });

  it("is empty for no rows", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("clearSince", () => {
  it("goes back an hour, to local midnight, or all the way", () => {
    expect(clearSince("hour", NOW)).toBe(NOW - 3_600_000);
    expect(clearSince("today", NOW)).toBe(new Date(2026, 8, 23).getTime());
    expect(clearSince("all", NOW)).toBeUndefined();
  });
});

describe("hostOf", () => {
  it("drops www. and keeps the port", () => {
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
    expect(hostOf("http://localhost:3000/")).toBe("localhost:3000");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
