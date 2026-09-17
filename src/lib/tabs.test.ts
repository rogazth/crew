import { describe, expect, it } from "vitest";
import {
  NO_TABS,
  activateTab,
  closeSessionTab,
  closeTab,
  isAgentTab,
  isTerminalTab,
  openTab,
  parseTabs,
  relativeTo,
  reopenTab,
  selectTab,
  sessionTabId,
  stepTab,
  tabHotkey,
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

describe("tabHotkey", () => {
  it("gives the first eight tabs their own digit", () => {
    expect(tabHotkey(0, 12)).toBe("tab-1");
    expect(tabHotkey(7, 12)).toBe("tab-8");
  });

  it("gives the ninth key to the last tab, however many there are", () => {
    expect(tabHotkey(11, 12)).toBe("last-tab");
    expect(tabHotkey(8, 12)).toBeNull();
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
