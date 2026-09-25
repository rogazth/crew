import { describe, expect, it } from "vitest";
import {
  NO_TABS,
  activateTab,
  closeSessionTab,
  closeTab,
  isAgentTab,
  isTerminalTab,
  lastUsed,
  openTab,
  parseTabs,
  panesOf,
  relativeTo,
  reopenTab,
  reorderTabs,
  selectTab,
  sessionTabId,
  stepTab,
  tabTitle,
  type TabState,
  withRecent,
} from "./tabs";
import type { Session, Tab } from "./types";

const sessionTab = (id: string): Tab => ({ id: sessionTabId(id), kind: "session", sessionId: id });

function opened(...ids: string[]): TabState {
  return ids.reduce((state, id) => openTab(state, sessionTab(id)), NO_TABS);
}

const agent = (id: string, name = id): Session =>
  ({ id, kind: "agent", name }) as Session;
const terminal = (id: string): Session => ({ id, kind: "terminal", name: id }) as Session;

describe("openTab", () => {
  it("adds a tab and focuses it", () => {
    const state = opened("a");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe("session:a");
  });

  it("focuses a tab that is already open instead of doubling it", () => {
    const state = openTab(opened("a", "b"), sessionTab("a"));
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("session:a");
  });
});

describe("the recent order", () => {
  // Each step as useTabs takes it: the change, then the order brought up to date.
  const visit = (state: TabState, ...ids: string[]) =>
    ids.reduce((s, id) => withRecent(selectTab(s, sessionTabId(id))), withRecent(state));
  const recent = (state: TabState) => state.recent?.map((id) => id.slice("session:".length));

  it("puts the tab on screen first, each tab once", () => {
    expect(recent(visit(opened("a", "b", "c"), "a", "b", "a"))).toEqual(["a", "b", "c"]);
  });

  it("forgets a tab that closes", () => {
    const state = withRecent(closeTab(visit(opened("a", "b", "c"), "b", "a"), "session:b"));
    expect(recent(state)).toEqual(["a", "c"]);
    expect(recent(withRecent(closeSessionTab(state, "c")))).toEqual(["a"]);
  });

  it("gives the same state back when nothing moved", () => {
    const state = visit(opened("a", "b"), "a");
    expect(withRecent(state)).toBe(state);
  });

  it("brings back the tab last on screen of those asked for, not the rightmost", () => {
    const state = visit(opened("a1", "a2", "m1"), "a1", "m1");
    expect(lastUsed(state, (tab) => tab.id.startsWith("session:a"))?.id).toBe("session:a1");
    expect(lastUsed(state)?.id).toBe("session:m1");
    expect(lastUsed(state, () => false)).toBeNull();
  });

  it("without a recent order, takes the active tab, then the rightmost", () => {
    const old: TabState = { tabs: opened("a1", "a2", "m1").tabs, activeId: "session:a1", closed: [] };
    expect(lastUsed(old, (tab) => tab.id !== "session:m1")?.id).toBe("session:a1");
    expect(lastUsed(old, (tab) => tab.id !== "session:a1")?.id).toBe("session:m1");
  });
});

describe("closeTab", () => {
  it("moves focus to the right neighbour", () => {
    const state = closeTab(selectTab(opened("a", "b", "c"), "session:b"), "session:b");
    expect(state.activeId).toBe("session:c");
  });

  it("falls back to the left when the closed tab was last", () => {
    const state = closeTab(opened("a", "b"), "session:b");
    expect(state.activeId).toBe("session:a");
  });

  it("leaves focus alone when another tab was closed", () => {
    const state = closeTab(selectTab(opened("a", "b", "c"), "session:a"), "session:c");
    expect(state.activeId).toBe("session:a");
  });

  it("ignores a tab that is not open", () => {
    const before = opened("a");
    expect(closeTab(before, "session:zzz")).toBe(before);
  });

  it("remembers what was closed so it can come back", () => {
    const state = reopenTab(closeTab(opened("a", "b"), "session:b"));
    expect(state.tabs.map((tab) => tab.id)).toEqual(["session:a", "session:b"]);
    expect(state.activeId).toBe("session:b");
  });

  it("keeps only the last ten closed tabs", () => {
    let state = opened(...Array.from({ length: 12 }, (_, n) => `s${n}`));
    for (let n = 0; n < 12; n += 1) state = closeTab(state, `session:s${n}`);
    expect(state.closed).toHaveLength(10);
  });
});

describe("closeSessionTab", () => {
  it("does not offer to reopen a tab whose session is gone", () => {
    const state = closeSessionTab(opened("a", "b"), "b");
    expect(state.tabs).toHaveLength(1);
    expect(state.closed).toHaveLength(0);
  });

  it("is a no-op when the session had no tab", () => {
    const before = opened("a");
    expect(closeSessionTab(before, "b")).toBe(before);
  });
});

describe("stepTab", () => {
  it("wraps forwards and backwards", () => {
    const state = opened("a", "b", "c");
    expect(stepTab(state, 1).activeId).toBe("session:a");
    expect(stepTab(selectTab(state, "session:a"), -1).activeId).toBe("session:c");
  });

  it("does nothing without tabs", () => {
    expect(stepTab(NO_TABS, 1)).toBe(NO_TABS);
  });
});

describe("activateTab", () => {
  it("counts from zero, and -1 is the last tab", () => {
    const state = opened("a", "b", "c");
    expect(activateTab(state, 0).activeId).toBe("session:a");
    expect(activateTab(state, -1).activeId).toBe("session:c");
  });

  it("keeps the state object when the index is out of range", () => {
    const state = opened("a");
    expect(activateTab(state, 7)).toBe(state);
  });
});

describe("reorderTabs", () => {
  const ids = (state: TabState) => state.tabs.map((tab) => tab.id);

  it("takes the dragged order and keeps focus on the same tab", () => {
    const state = reorderTabs(opened("a", "b", "c"), ["session:c", "session:a", "session:b"]);
    expect(ids(state)).toEqual(["session:c", "session:a", "session:b"]);
    expect(state.activeId).toBe("session:c");
  });

  it("keeps the state object when nothing moved", () => {
    const state = opened("a", "b");
    expect(reorderTabs(state, ["session:a", "session:b"])).toBe(state);
  });

  it("drops a stale order that misses, invents or repeats a tab", () => {
    const state = opened("a", "b");
    expect(reorderTabs(state, ["session:b"])).toBe(state);
    expect(reorderTabs(state, ["session:b", "session:x"])).toBe(state);
    expect(reorderTabs(state, ["session:b", "session:b", "session:a"])).toBe(state);
  });
});

describe("parseTabs", () => {
  it("restores what was written", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: "session:a" });
    expect(parseTabs(raw).tabs).toHaveLength(1);
    expect(parseTabs(raw).activeId).toBe("session:a");
  });

  it("drops rows that no longer parse instead of throwing", () => {
    const raw = JSON.stringify({
      tabs: [sessionTab("a"), { id: "broken", kind: "file" }, { kind: "session" }],
      activeId: "session:a",
    });
    expect(parseTabs(raw).tabs.map((tab) => tab.id)).toEqual(["session:a"]);
  });

  it("drops a side chat saved before it was removed", () => {
    const raw = JSON.stringify({
      tabs: [sessionTab("a"), { id: "stub:sidechat", kind: "stub", stub: "sidechat", title: "Side Chat" }],
      activeId: "stub:sidechat",
    });
    expect(parseTabs(raw).tabs.map((tab) => tab.id)).toEqual(["session:a"]);
    expect(parseTabs(raw).activeId).toBe("session:a");
  });

  it("falls back to the first tab when the active one did not survive", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: "session:gone" });
    expect(parseTabs(raw).activeId).toBe("session:a");
  });

  it("answers with nothing for junk", () => {
    expect(parseTabs("not json")).toEqual(NO_TABS);
    expect(parseTabs(null)).toEqual(NO_TABS);
    expect(parseTabs("[]")).toEqual(NO_TABS);
  });

  it("restores the recent order, without tabs that did not survive", () => {
    const raw = JSON.stringify({
      tabs: [sessionTab("a"), sessionTab("b")],
      activeId: "session:b",
      recent: ["session:b", "session:gone", "session:a", 7],
    });
    expect(parseTabs(raw).recent).toEqual(["session:b", "session:a"]);
  });

  it("reads a strip saved before the recent order as having none", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: "session:a" });
    expect(parseTabs(raw).recent).toBeUndefined();
  });

  it("never restores the reopen stack", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: null, closed: [sessionTab("b")] });
    expect(parseTabs(raw).closed).toEqual([]);
  });
});

describe("what a tab is", () => {
  const sessions = [agent("a", "Planner"), terminal("t")];

  it("knows an agent tab from a terminal one", () => {
    expect(isAgentTab(sessionTab("a"), sessions)).toBe(true);
    expect(isAgentTab(sessionTab("t"), sessions)).toBe(false);
    expect(isTerminalTab(sessionTab("t"), sessions)).toBe(true);
  });

  it("counts the terminal stub as a terminal", () => {
    const stub: Tab = { id: "stub:terminal", kind: "stub", stub: "terminal", title: "Terminal" };
    expect(isTerminalTab(stub, sessions)).toBe(true);
    expect(isAgentTab(stub, sessions)).toBe(false);
  });

  it("titles a tab after its session, its file or its stub", () => {
    expect(tabTitle(sessionTab("a"), sessions)).toBe("Planner");
    expect(tabTitle({ id: "f", kind: "file", path: "/w/src/a.ts", relative: "src/a.ts" }, sessions)).toBe("a.ts");
    expect(tabTitle({ id: "s", kind: "stub", stub: "terminal", title: "Terminal" }, sessions)).toBe("Terminal");
  });

  it("says Untitled for a session that is gone", () => {
    expect(tabTitle(sessionTab("ghost"), sessions)).toBe("Untitled");
  });
});

describe("relativeTo", () => {
  it("shortens a path inside the workspace", () => {
    expect(relativeTo("/w", "/w/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/w/", "/w/src/a.ts")).toBe("src/a.ts");
  });

  it("leaves a path outside it alone", () => {
    expect(relativeTo("/w", "/etc/hosts")).toBe("/etc/hosts");
    expect(relativeTo("/w", "/workspace-other/a.ts")).toBe("/workspace-other/a.ts");
  });
});

describe("panesOf", () => {
  const stub: Tab = { id: "stub:terminal", kind: "stub", stub: "terminal", title: "Terminal" };
  const registry = {
    one: { tabs: [sessionTab("a"), stub], activeId: "stub:terminal", closed: [] },
    two: { tabs: [stub], activeId: "stub:terminal", closed: [] },
  };

  it("mounts every tab of every restored workspace", () => {
    expect(panesOf(registry, "one").map((pane) => pane.id)).toEqual([
      "one/session:a",
      "one/stub:terminal",
      "two/stub:terminal",
    ]);
  });

  it("shows only the active tab of the active workspace", () => {
    const visible = panesOf(registry, "one").filter((pane) => pane.visible);
    expect(visible.map((pane) => pane.id)).toEqual(["one/stub:terminal"]);
  });

  it("shows nothing while no workspace is active", () => {
    expect(panesOf(registry, null).some((pane) => pane.visible)).toBe(false);
  });
});
