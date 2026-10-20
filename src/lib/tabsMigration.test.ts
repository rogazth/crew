import { describe, expect, it } from "vitest";
import { legacyWorkspace, mergeLegacyTabs } from "./tabsMigration";
import { NO_TABS, openTab, sessionTabId, type TabState } from "./tabs";
import type { Tab } from "./types";

const tab = (id: string): Tab => ({ id: sessionTabId(id), kind: "session", sessionId: id });
const strip = (...ids: string[]): TabState => ids.reduce((s, id) => openTab(s, tab(id)), NO_TABS);
const ids = (state: TabState) => state.tabs.map((t) => t.id);

describe("mergeLegacyTabs", () => {
  it("appends each worktree strip, in order, after the workspace's own", () => {
    const merged = mergeLegacyTabs(strip("a"), [strip("b", "c"), strip("d")]);
    expect(ids(merged)).toEqual(["a", "b", "c", "d"].map(sessionTabId));
  });

  it("skips a tab id that is already there", () => {
    const merged = mergeLegacyTabs(strip("a", "b"), [strip("b", "c"), strip("c", "a")]);
    expect(ids(merged)).toEqual(["a", "b", "c"].map(sessionTabId));
  });

  it("keeps the workspace's active tab", () => {
    const base = { ...strip("a"), activeId: sessionTabId("a") };
    expect(mergeLegacyTabs(base, [strip("b")]).activeId).toBe(sessionTabId("a"));
  });

  it("returns the same strip when there is nothing to add", () => {
    const base = strip("a");
    expect(mergeLegacyTabs(base, [strip("a"), NO_TABS])).toBe(base);
  });
});

describe("legacyWorkspace", () => {
  it("names the workspace of a worktree key only", () => {
    expect(legacyWorkspace("tabs:w1@/tmp/feat")).toBe("w1");
    expect(legacyWorkspace("tabs:w1")).toBeNull();
    expect(legacyWorkspace("tabs:scope")).toBeNull();
    expect(legacyWorkspace("other:w1@x")).toBeNull();
  });
});
