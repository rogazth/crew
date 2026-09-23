import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  canReorder,
  groupSessions,
  isDefault,
  parsePrefs,
  shows,
  toggle,
  type SidebarPrefs,
} from "./sidebarPrefs";
import type { Session } from "./types";

const prefs = (over: Partial<SidebarPrefs> = {}): SidebarPrefs => ({ ...DEFAULT_PREFS, ...over });

const session = (name: string, over: Partial<Session> = {}): Session => ({
  id: name,
  workspaceId: "w1",
  kind: "terminal",
  name,
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ids = (groups: { sessions: Session[] }[]) => groups.map((group) => group.sessions.map((s) => s.id));

describe("shows", () => {
  it("is true only for the details the user kept", () => {
    expect(shows(prefs({ show: ["status"] }), "status")).toBe(true);
    expect(shows(prefs({ show: ["status"] }), "avatar")).toBe(false);
  });
});

describe("isDefault", () => {
  it("is true for the shipped layout", () => {
    expect(isDefault(DEFAULT_PREFS)).toBe(true);
  });

  it("is false once anything changed", () => {
    expect(isDefault(prefs({ grouping: "status" }))).toBe(false);
    expect(isDefault(prefs({ ordering: "name" }))).toBe(false);
    expect(isDefault(prefs({ show: ["provider"] }))).toBe(false);
    expect(isDefault(prefs({ hiddenKinds: ["agent"] }))).toBe(false);
    expect(isDefault(prefs({ hiddenProviders: ["codex"] }))).toBe(false);
  });
});

describe("toggle", () => {
  it("adds a missing value at the end and removes a present one", () => {
    expect(toggle(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggle(["a", "b"], "a")).toEqual(["b"]);
    expect(toggle([], "a")).toEqual(["a"]);
  });

  it("returns a new list", () => {
    const list = ["a"];
    expect(toggle(list, "b")).not.toBe(list);
    expect(list).toEqual(["a"]);
  });
});

describe("canReorder", () => {
  it("allows dragging only in manual order, grouped by kind, while not filtering", () => {
    expect(canReorder(prefs({ ordering: "manual", grouping: "kind" }), false)).toBe(true);
    expect(canReorder(prefs({ ordering: "manual", grouping: "kind" }), true)).toBe(false);
    expect(canReorder(prefs({ ordering: "updated", grouping: "kind" }), false)).toBe(false);
    expect(canReorder(prefs({ ordering: "manual", grouping: "none" }), false)).toBe(false);
  });
});

describe("parsePrefs", () => {
  it("starts from the defaults when nothing is stored", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("")).toEqual(DEFAULT_PREFS);
  });

  it("round-trips what the sidebar saves", () => {
    const saved: SidebarPrefs = {
      grouping: "provider",
      ordering: "manual",
      show: ["status", "avatar"],
      hiddenKinds: ["agent"],
      hiddenProviders: ["codex", "cursor"],
    };
    expect(parsePrefs(JSON.stringify(saved))).toEqual(saved);
    expect(parsePrefs(JSON.stringify(DEFAULT_PREFS))).toEqual(DEFAULT_PREFS);
  });

  it("falls back to the defaults for corrupt JSON", () => {
    expect(parsePrefs("{grouping:")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("null")).toEqual(DEFAULT_PREFS);
  });

  it("falls back per field for values of the wrong shape", () => {
    expect(
      parsePrefs(JSON.stringify({ grouping: "folder", ordering: 3, show: "status", hiddenKinds: {}, hiddenProviders: "x" })),
    ).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[]")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("7")).toEqual(DEFAULT_PREFS);
  });

  it("keeps the known entries of a list and drops the rest", () => {
    const parsed = parsePrefs(
      JSON.stringify({ show: ["status", "color", 1], hiddenKinds: ["agent", "browser"], hiddenProviders: ["codex", 2, null] }),
    );
    expect(parsed.show).toEqual(["status"]);
    expect(parsed.hiddenKinds).toEqual(["agent"]);
    expect(parsed.hiddenProviders).toEqual(["codex"]);
  });

  it("keeps an empty detail list as the user's choice", () => {
    expect(parsePrefs(JSON.stringify({ show: [] })).show).toEqual([]);
  });
});

describe("groupSessions", () => {
  const agentOld = session("agent-old", { kind: "agent", updatedAt: 1, status: "done" });
  const termNew = session("term-new", { updatedAt: 9, provider: "codex", status: "working" });
  const agentNew = session("agent-new", { kind: "agent", updatedAt: 5, provider: "cursor", status: "needs-input" });
  const termOld = session("term-old", { updatedAt: 2, status: "working" });
  const all = [agentOld, termNew, agentNew, termOld];

  it("groups agents before sessions by default, most recently updated first", () => {
    const groups = groupSessions(all, DEFAULT_PREFS, "");
    expect(groups.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual([
      { id: "agent", label: "Agents", kind: "agent" },
      { id: "terminal", label: "Sessions", kind: "terminal" },
    ]);
    expect(ids(groups)).toEqual([["agent-new", "agent-old"], ["term-new", "term-old"]]);
  });

  it("leaves out a kind with no sessions", () => {
    const groups = groupSessions([termOld], DEFAULT_PREFS, "");
    expect(groups.map((group) => group.id)).toEqual(["terminal"]);
  });

  it("puts everything in one list without grouping, and nothing when it is empty", () => {
    const groups = groupSessions(all, prefs({ grouping: "none" }), "");
    expect(groups).toEqual([{ id: "all", label: "All", kind: null, sessions: [termNew, agentNew, termOld, agentOld] }]);
    expect(groupSessions([], prefs({ grouping: "none" }), "")).toEqual([]);
  });

  it("orders by name or keeps the manual order", () => {
    expect(ids(groupSessions(all, prefs({ grouping: "none", ordering: "name" }), ""))).toEqual([
      ["agent-new", "agent-old", "term-new", "term-old"],
    ]);
    expect(ids(groupSessions(all, prefs({ grouping: "none", ordering: "manual" }), ""))).toEqual([
      ["agent-old", "term-new", "agent-new", "term-old"],
    ]);
  });

  it("groups by provider in order of first appearance, labelled from the registry", () => {
    const stranger = session("stranger", { provider: "aider", updatedAt: 0 });
    const groups = groupSessions([...all, stranger], prefs({ grouping: "provider" }), "");
    expect(groups.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual([
      { id: "codex", label: "Codex", kind: null },
      { id: "cursor", label: "Cursor", kind: null },
      { id: "claude", label: "Claude", kind: null },
      { id: "aider", label: "aider", kind: null },
    ]);
    expect(ids(groups)).toEqual([["term-new"], ["agent-new"], ["term-old", "agent-old"], ["stranger"]]);
  });

  it("groups by status, loudest first", () => {
    const groups = groupSessions(all, prefs({ grouping: "status" }), "");
    expect(groups.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "needs-input", label: "Needs input" },
      { id: "working", label: "Working" },
      { id: "done", label: "Unread" },
    ]);
    expect(ids(groups)).toEqual([["agent-new"], ["term-new", "term-old"], ["agent-old"]]);
  });

  it("hides the kinds and providers the user switched off", () => {
    expect(ids(groupSessions(all, prefs({ hiddenKinds: ["agent"] }), ""))).toEqual([["term-new", "term-old"]]);
    expect(ids(groupSessions(all, prefs({ grouping: "none", hiddenProviders: ["claude"] }), ""))).toEqual([
      ["term-new", "agent-new"],
    ]);
  });

  it("keeps only sessions that match the search", () => {
    expect(ids(groupSessions(all, prefs({ grouping: "none" }), "old"))).toEqual([["term-old", "agent-old"]]);
    expect(groupSessions(all, DEFAULT_PREFS, "zzz")).toEqual([]);
  });
});
