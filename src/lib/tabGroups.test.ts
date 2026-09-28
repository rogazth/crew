import { describe, expect, it } from "vitest";
import {
  collapseGroup,
  collapseOthers,
  expandGroup,
  groupItemId,
  itemOrder,
  revealActive,
  stripItems,
  visibleIn,
  type PlaceOf,
} from "./tabGroups";
import { NO_TABS, closeTab, openTab, pinTab, selectTab, stepTab, type TabState } from "./tabs";
import type { Tab } from "./types";

/** `a1` lives in worktree `a`, `b2` in `b`; a page belongs to none. */
const tab = (id: string): Tab =>
  id.startsWith("page") ? { id, kind: "browser", url: "", title: id } : { id, kind: "session", sessionId: id };
const placeOf: PlaceOf = (t) => (t.id.startsWith("page") ? null : t.id[0]!);

function strip(ids: string[], active = ids.at(-1)!): TabState {
  const state = ids.reduce((s, id) => openTab(s, tab(id)), NO_TABS);
  return selectTab(state, active);
}
const order = (state: TabState) => state.tabs.map((t) => t.id);

describe("collapseGroup", () => {
  it("gathers a worktree's tabs where the fold was asked for", () => {
    const state = collapseGroup(strip(["a1", "b1", "a2", "b2", "a3"], "b1"), "a", "a2", placeOf);
    expect(order(state)).toEqual(["b1", "a1", "a2", "a3", "b2"]);
    expect(state.collapsed).toEqual(["a"]);
    expect(state.activeId).toBe("b1");
  });

  it("moves the tab on screen to the last used one that still shows", () => {
    let state = strip(["a1", "b1", "page", "a2"], "b1");
    state = { ...selectTab(state, "a2"), recent: ["a2", "page", "b1"] };
    expect(collapseGroup(state, "a", "a2", placeOf).activeId).toBe("page");
  });

  it("does nothing when no other tab would show", () => {
    const state = strip(["a1", "a2"]);
    expect(collapseGroup(state, "a", "a1", placeOf)).toBe(state);
  });

  it("leaves pinned tabs out", () => {
    const state = collapseGroup(pinTab(strip(["a1", "b1", "a2"], "b1"), "a1"), "a", "a2", placeOf);
    expect(visibleIn(state, placeOf)(state.tabs[0]!)).toBe(true);
    expect(stripItems(state.tabs.slice(1), state.collapsed!, placeOf).map((item) => item.kind)).toEqual([
      "tab",
      "group",
    ]);
  });
});

describe("collapseOthers", () => {
  it("folds every worktree but the one asked from", () => {
    const state = collapseOthers(strip(["a1", "b1", "c1", "a2", "page"], "a1"), "a", placeOf);
    expect(state.collapsed).toEqual(["b", "c"]);
    expect(state.activeId).toBe("a1");
  });
});

describe("expandGroup", () => {
  it("unfolds where the chip stood, dropping the fold", () => {
    const folded = collapseGroup(strip(["a1", "b1", "a2"], "b1"), "a", "a1", placeOf);
    const state = expandGroup(folded, "a", placeOf);
    expect(order(state)).toEqual(["a1", "a2", "b1"]);
    expect(state.collapsed).toBeUndefined();
  });

  it("gathers a tab that joined the worktree while folded", () => {
    const folded = collapseGroup(strip(["a1", "b1", "a2"], "b1"), "a", "a1", placeOf);
    const joined = openTab(folded, tab("a3"), { background: true });
    expect(order(expandGroup(joined, "a", placeOf))).toEqual(["a1", "a2", "a3", "b1"]);
  });
});

describe("revealActive", () => {
  it("unfolds the worktree of a tab brought on screen", () => {
    const folded = collapseGroup(strip(["a1", "b1", "a2"], "b1"), "a", "a1", placeOf);
    const state = revealActive(selectTab(folded, "a2"), placeOf);
    expect(state.collapsed).toBeUndefined();
    expect(state.activeId).toBe("a2");
  });

  it("leaves a strip whose tab on screen shows", () => {
    const folded = collapseGroup(strip(["a1", "b1"], "b1"), "a", "a1", placeOf);
    expect(revealActive(folded, placeOf)).toBe(folded);
  });
});

describe("folded tabs and the keyboard", () => {
  const folded = collapseGroup(strip(["b1", "a1", "b2", "a2", "page"], "b1"), "a", "a1", placeOf);

  it("steps past them", () => {
    const visible = visibleIn(folded, placeOf);
    expect(stepTab(folded, 1, visible).activeId).toBe("b2");
    expect(stepTab(folded, -1, visible).activeId).toBe("page");
  });

  it("closing lands on a tab that shows", () => {
    const state = closeTab(selectTab(folded, "b2"), "b2", visibleIn(folded, placeOf));
    expect(state.activeId).toBe("page");
  });
});

describe("stripItems", () => {
  it("draws a folded worktree as one chip where its first tab stands", () => {
    const tabs = ["b1", "a1", "page", "a2"].map(tab);
    const items = stripItems(tabs, ["a"], placeOf);
    expect(items.map((item) => (item.kind === "tab" ? item.tab.id : item.id))).toEqual([
      "b1",
      groupItemId("a"),
      "page",
    ]);
    const group = items[1]!;
    expect(group.kind === "group" && group.tabs.map((t) => t.id)).toEqual(["a1", "a2"]);
  });

  it("maps a dragged order of chips back to their tabs", () => {
    const tabs = ["b1", "a1", "a2"].map(tab);
    const items = stripItems(tabs, ["a"], placeOf);
    expect(itemOrder([groupItemId("a"), "b1"], items)).toEqual(["a1", "a2", "b1"]);
  });
});
