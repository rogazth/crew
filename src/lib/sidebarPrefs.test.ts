import { describe, expect, it } from "vitest";
import { arrangeSessions, DEFAULT_PREFS, parsePrefs, trimSection } from "./sidebarPrefs";
import type { Session } from "./types";

const session = (
  id: string,
  kind: Session["kind"],
  updatedAt: number,
  provider = "claude",
  status: Session["status"] = "idle",
) => ({ id, kind, name: id, provider, model: "", updatedAt, status }) as Session;

describe("parsePrefs", () => {
  it("drops what older builds stored and keeps what still means something", () => {
    const raw = JSON.stringify({ grouping: "status", ordering: "manual", show: ["avatar", "status"] });
    expect(parsePrefs(raw)).toEqual({ ...DEFAULT_PREFS, ordering: "manual", show: ["status"] });
  });

  it("keeps only the limits and spans the menu offers", () => {
    expect(parsePrefs(JSON.stringify({ limit: 20, recency: "week" }))).toMatchObject({ limit: 20, recency: "week" });
    expect(parsePrefs(JSON.stringify({ limit: 0 })).limit).toBe(0);
    expect(parsePrefs(JSON.stringify({ limit: 7, recency: "year" }))).toMatchObject({ limit: 10, recency: "any" });
  });

  it("falls back to the defaults on garbage", () => {
    expect(parsePrefs("{")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null).ordering).toBe("updated");
  });
});

describe("arrangeSessions", () => {
  const list = [session("a", "agent", 1), session("t", "terminal", 3), session("b", "agent", 2, "codex")];

  it("splits by kind, newest first", () => {
    const { agents, terminals } = arrangeSessions(list, DEFAULT_PREFS, "");
    expect(agents.map((s) => s.id)).toEqual(["b", "a"]);
    expect(terminals.map((s) => s.id)).toEqual(["t"]);
  });

  it("hides filtered kinds and providers", () => {
    const prefs = { ...DEFAULT_PREFS, hiddenKinds: ["terminal" as const], hiddenProviders: ["codex"] };
    const { agents, terminals } = arrangeSessions(list, prefs, "");
    expect(agents.map((s) => s.id)).toEqual(["a"]);
    expect(terminals).toEqual([]);
  });
});

describe("trimSection", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1000 * HOUR;
  const ids = (list: Session[]) => list.map((s) => s.id);
  const rows = Array.from({ length: 6 }, (_, at) => session(`s${at}`, "terminal", now - at * 24 * HOUR));

  it("keeps the first rows up to the limit and counts the rest", () => {
    const { shown, hidden } = trimSection(rows, { ...DEFAULT_PREFS, limit: 5 }, null, now);
    expect(ids(shown)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(hidden).toBe(1);
  });

  it("drops what has not moved within the span", () => {
    const { shown, hidden } = trimSection(rows, { ...DEFAULT_PREFS, recency: "3days", limit: 0 }, null, now);
    expect(ids(shown)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(hidden).toBe(2);
  });

  it("never drops the open row or one with something going on, and they use up the limit", () => {
    const list = [...rows.slice(0, 5), session("busy", "terminal", 0, "claude", "working")];
    const { shown, hidden } = trimSection(list, { ...DEFAULT_PREFS, recency: "day", limit: 5 }, "s4", now);
    expect(ids(shown)).toEqual(["s0", "s1", "s4", "busy"]);
    expect(hidden).toBe(2);
    const tight = trimSection(list, { ...DEFAULT_PREFS, limit: 5 }, "s4", now);
    expect(ids(tight.shown)).toEqual(["s0", "s1", "s2", "s4", "busy"]);
  });
});
