import { describe, expect, it } from "vitest";
import { NO_SELECTION, pruneSelection, selectClick, type Selection } from "./selection";

const order = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

describe("selectClick", () => {
  it("replaces the selection on a plain click and anchors there", () => {
    const selection: Selection = { ids: ["a", "b"], anchor: "a" };
    expect(selectClick(selection, order, "d", plain)).toEqual({ ids: ["d"], anchor: "d" });
    expect(selectClick(NO_SELECTION, order, "c", plain)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("adds an unselected row on ⌘/Ctrl click and moves the anchor to it", () => {
    expect(selectClick({ ids: ["a"], anchor: "a" }, order, "c", toggle)).toEqual({ ids: ["a", "c"], anchor: "c" });
  });

  it("removes a selected row on ⌘/Ctrl click", () => {
    expect(selectClick({ ids: ["a", "c"], anchor: "a" }, order, "a", toggle)).toEqual({ ids: ["c"], anchor: "a" });
    expect(selectClick({ ids: ["a"], anchor: "a" }, order, "a", toggle)).toEqual({ ids: [], anchor: "a" });
  });

  it("extends from the anchor to the clicked row in list order on Shift click", () => {
    expect(selectClick({ ids: ["b"], anchor: "b" }, order, "d", range)).toEqual({ ids: ["b", "c", "d"], anchor: "b" });
  });

  it("extends upward the same way, keeping list order", () => {
    expect(selectClick({ ids: ["d"], anchor: "d" }, order, "b", range)).toEqual({ ids: ["b", "c", "d"], anchor: "d" });
  });

  it("replaces a toggled set with the range, keeping the anchor", () => {
    const scattered: Selection = { ids: ["a", "e"], anchor: "c" };
    expect(selectClick(scattered, order, "d", range)).toEqual({ ids: ["c", "d"], anchor: "c" });
    expect(selectClick(scattered, order, "c", range)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("lets Shift win over ⌘ when both are held", () => {
    expect(selectClick({ ids: ["a"], anchor: "a" }, order, "c", { toggle: true, range: true })).toEqual({
      ids: ["a", "b", "c"],
      anchor: "a",
    });
  });

  it("falls back to a toggle or plain click when Shift has no anchor", () => {
    expect(selectClick(NO_SELECTION, order, "c", range)).toEqual({ ids: ["c"], anchor: "c" });
    expect(selectClick({ ids: ["a"], anchor: null }, order, "c", { toggle: true, range: true })).toEqual({
      ids: ["a", "c"],
      anchor: "c",
    });
  });

  it("starts over at the clicked row when the anchor or the row is not in the list", () => {
    expect(selectClick({ ids: ["x"], anchor: "x" }, order, "c", range)).toEqual({ ids: ["c"], anchor: "c" });
    expect(selectClick({ ids: ["a"], anchor: "a" }, order, "zz", range)).toEqual({ ids: ["zz"], anchor: "zz" });
  });
});

describe("pruneSelection", () => {
  it("returns the same selection when every id is still listed", () => {
    const selection: Selection = { ids: ["a", "c"], anchor: "c" };
    expect(pruneSelection(selection, order)).toBe(selection);
    expect(pruneSelection(NO_SELECTION, [])).toBe(NO_SELECTION);
  });

  it("drops ids that left the list and keeps a visible anchor", () => {
    expect(pruneSelection({ ids: ["a", "x", "c"], anchor: "a" }, order)).toEqual({ ids: ["a", "c"], anchor: "a" });
  });

  it("drops the anchor once it is gone", () => {
    expect(pruneSelection({ ids: ["x", "c"], anchor: "x" }, order)).toEqual({ ids: ["c"], anchor: null });
    expect(pruneSelection({ ids: ["x"], anchor: "x" }, [])).toEqual({ ids: [], anchor: null });
  });

  it("keeps a null anchor null", () => {
    expect(pruneSelection({ ids: ["x", "a"], anchor: null }, order)).toEqual({ ids: ["a"], anchor: null });
  });
});
