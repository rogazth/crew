import { describe, expect, it } from "vitest";
import {
  NO_TABS,
  activateTab,
  closeSessionTab,
  closeTab,
  fileTabId,
  isAgentTab,
  isTerminalTab,
  mergeRestored,
  openTab,
  parseTabs,
  panesOf,
  relativeTo,
  reopenTab,
  selectTab,
  sessionTabId,
  stepTab,
  stubTabId,
  tabTitle,
  type TabState,
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

  it("has nothing to reopen before anything was closed", () => {
    const before = opened("a");
    expect(reopenTab(before)).toBe(before);
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

  it("lands on the first tab when none was active", () => {
    const state = selectTab(opened("a", "b"), null);
    expect(stepTab(state, 1).activeId).toBe("session:a");
    expect(stepTab(state, -1).activeId).toBe("session:a");
  });
});

describe("selectTab", () => {
  it("keeps the state object when the tab is already active", () => {
    const state = opened("a", "b");
    expect(selectTab(state, "session:b")).toBe(state);
    expect(selectTab(state, "session:a").activeId).toBe("session:a");
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

  it("falls back to the first tab when the active one did not survive", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: "session:gone" });
    expect(parseTabs(raw).activeId).toBe("session:a");
  });

  it("answers with nothing for junk", () => {
    expect(parseTabs("not json")).toEqual(NO_TABS);
    expect(parseTabs(null)).toEqual(NO_TABS);
    expect(parseTabs("[]")).toEqual(NO_TABS);
  });

  it("answers with nothing for JSON that is not an object", () => {
    expect(parseTabs("5")).toEqual(NO_TABS);
    expect(parseTabs("null")).toEqual(NO_TABS);
    expect(parseTabs('{"tabs":"a"}')).toEqual(NO_TABS);
  });

  it("restores file and stub tabs alongside session ones", () => {
    const file: Tab = { id: fileTabId("/w/src/a.ts"), kind: "file", path: "/w/src/a.ts", relative: "src/a.ts" };
    const stub: Tab = { id: stubTabId("browser"), kind: "stub", stub: "browser", title: "Browser" };
    const raw = JSON.stringify({ tabs: [sessionTab("a"), file, stub], activeId: stub.id });
    expect(parseTabs(raw)).toEqual({ tabs: [sessionTab("a"), file, stub], activeId: "stub:browser", closed: [] });
  });

  it("drops a stub it no longer knows and a tab of an unknown kind", () => {
    const raw = JSON.stringify({
      tabs: [
        { id: "stub:gone", kind: "stub", stub: "gone", title: "Gone" },
        { id: "stub:terminal", kind: "stub", stub: "terminal" },
        { id: "x", kind: "diff" },
        "session:a",
        null,
        sessionTab("b"),
      ],
      activeId: "stub:gone",
    });
    expect(parseTabs(raw).tabs.map((tab) => tab.id)).toEqual(["session:b"]);
  });

  it("has no active tab when no tab survived", () => {
    const raw = JSON.stringify({ tabs: [{ kind: "session" }], activeId: "session:a" });
    expect(parseTabs(raw)).toEqual({ tabs: [], activeId: null, closed: [] });
  });

  it("never restores the reopen stack", () => {
    const raw = JSON.stringify({ tabs: [sessionTab("a")], activeId: null, closed: [sessionTab("b")] });
    expect(parseTabs(raw).closed).toEqual([]);
  });
});

describe("mergeRestored", () => {
  it("puts the saved tabs first, then the new ones, and keeps the tab on screen", () => {
    const live = closeTab(opened("b", "c"), sessionTabId("b"));
    const merged = mergeRestored({ ...opened("a", "c"), activeId: sessionTabId("a") }, live);
    expect(merged.tabs.map((tab) => tab.id)).toEqual([sessionTabId("a"), sessionTabId("c")]);
    expect(merged.activeId).toBe(sessionTabId("c"));
    expect(merged.closed).toEqual(live.closed);
  });

  it("takes the saved active tab when nothing is on screen", () => {
    const merged = mergeRestored({ ...opened("a", "b"), activeId: sessionTabId("a") }, NO_TABS);
    expect(merged.activeId).toBe(sessionTabId("a"));
  });
});

describe("what a tab is", () => {
  const sessions = [agent("a", "Planner"), terminal("t")];

  it("knows an agent tab from a terminal one", () => {
    expect(isAgentTab(sessionTab("a"), sessions)).toBe(true);
    expect(isAgentTab(sessionTab("t"), sessions)).toBe(false);
    expect(isTerminalTab(sessionTab("t"), sessions)).toBe(true);
  });

  it("says no when there is no tab, or it is a file", () => {
    const file: Tab = { id: fileTabId("/w/a.ts"), kind: "file", path: "/w/a.ts", relative: "a.ts" };
    expect(isAgentTab(null, sessions)).toBe(false);
    expect(isTerminalTab(null, sessions)).toBe(false);
    expect(isTerminalTab(file, sessions)).toBe(false);
    expect(isAgentTab(file, sessions)).toBe(false);
  });

  it("does not count a browser stub as a terminal", () => {
    const stub: Tab = { id: stubTabId("browser"), kind: "stub", stub: "browser", title: "Browser" };
    expect(isTerminalTab(stub, sessions)).toBe(false);
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

describe("tab ids", () => {
  it("keeps a session, a file and a stub apart even when they share a name", () => {
    const ids = [sessionTabId("terminal"), fileTabId("terminal"), stubTabId("terminal")];
    expect(new Set(ids).size).toBe(3);
  });

  it("opens the same file once however often it is asked for", () => {
    const tab = (): Tab => ({ id: fileTabId("/w/a.ts"), kind: "file", path: "/w/a.ts", relative: "a.ts" });
    const state = openTab(openTab(opened("a"), tab()), tab());
    expect(state.tabs.map((t) => t.id)).toEqual(["session:a", "file:/w/a.ts"]);
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
