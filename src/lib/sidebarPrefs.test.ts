import { describe, expect, it } from "vitest";
import { arrangeSessions, childrenOf, DEFAULT_PREFS, parsePrefs, trimSection } from "./sidebarPrefs";
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

describe("childrenOf", () => {
  const child = (id: string, parentId: string | undefined, createdAt: number) =>
    ({ ...session(id, "child", createdAt, "codex"), parentId, createdAt }) as Session;
  const list = [
    session("planner", "agent", 1),
    session("shell", "terminal", 2),
    child("c2", "shell", 20),
    child("c1", "shell", 10),
    child("mine", "planner", 5),
    child("loose", undefined, 7),
    child("orphan", "gone", 8),
  ];

  it("nests a session under whoever started it, oldest first", () => {
    const nested = childrenOf(list, DEFAULT_PREFS, "");
    expect(nested.get("shell")?.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(nested.get("planner")?.map((s) => s.id)).toEqual(["mine"]);
  });

  it("lists the nested ones under their parent only, and the rest among the sessions", () => {
    const { agents, terminals } = arrangeSessions(list, DEFAULT_PREFS, "");
    expect(agents.map((s) => s.id)).toEqual(["planner"]);
    expect(terminals.map((s) => s.id).sort()).toEqual(["loose", "orphan", "shell"]);
  });

  it("lists every match flat while searching", () => {
    expect(childrenOf(list, DEFAULT_PREFS, "c").size).toBe(0);
    const { terminals } = arrangeSessions(list, DEFAULT_PREFS, "c1");
    expect(terminals.map((s) => s.id)).toEqual(["c1"]);
  });

  it("lets an exited child age out like an idle one", () => {
    const exited = { ...child("old", "shell", 1), status: "exited" as const, updatedAt: 1 };
    const { shown } = trimSection([exited], { ...DEFAULT_PREFS, recency: "day" }, null, 10 * 24 * 60 * 60 * 1000);
    expect(shown).toEqual([]);
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
