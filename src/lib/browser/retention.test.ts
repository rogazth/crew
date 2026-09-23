import { describe, expect, it } from "vitest";
import { DEFAULT_KEEP, forget, liveGuests, touch } from "./retention";

const none: ReadonlySet<string> = new Set();

function live(order: string[], visible: string | null, keep: number, pinned: ReadonlySet<string> = none) {
  return [...liveGuests({ order, visible, keep, pinned })].sort();
}

describe("touch", () => {
  it("moves a page to the front", () => {
    expect(touch(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("adds a page it has not seen", () => {
    expect(touch(["a"], "b")).toEqual(["b", "a"]);
    expect(touch([], "a")).toEqual(["a"]);
  });

  it("returns the same array when the page is already first", () => {
    const order = ["a", "b"];
    expect(touch(order, "a")).toBe(order);
  });

  it("leaves one copy of the page it moves", () => {
    expect(touch(["b", "a", "c", "a"], "a")).toEqual(["a", "b", "c"]);
  });
});

describe("forget", () => {
  it("removes a page", () => {
    expect(forget(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("returns the same array when the page is absent", () => {
    const order = ["a", "b"];
    expect(forget(order, "z")).toBe(order);
  });

  it("removes every copy of a duplicated page", () => {
    expect(forget(["a", "b", "a"], "a")).toEqual(["b"]);
  });
});

describe("liveGuests", () => {
  it("keeps the visible page and the most recent hidden ones", () => {
    expect(live(["a", "b", "c", "d", "e"], "a", 2)).toEqual(["a", "b", "c"]);
  });

  it("does not count the visible page against the budget", () => {
    expect(live(["b", "a", "c", "d"], "a", 2)).toEqual(["a", "b", "c"]);
  });

  it("keeps the visible page even when the order does not know it yet", () => {
    expect(live(["b", "c"], "new", 1)).toEqual(["b", "new"]);
  });

  it("keeps pinned pages without spending the budget on them", () => {
    expect(live(["a", "b", "c", "d", "e"], "a", 1, new Set(["b", "e"]))).toEqual(["a", "b", "c", "e"]);
  });

  it("keeps a pinned page that the order does not know", () => {
    expect(live(["a"], "a", 0, new Set(["downloading"]))).toEqual(["a", "downloading"]);
  });

  it("keeps only the visible and pinned pages when the budget is zero or less", () => {
    expect(live(["a", "b", "c"], "a", 0, new Set(["c"]))).toEqual(["a", "c"]);
    expect(live(["a", "b", "c"], "a", -3)).toEqual(["a"]);
  });

  it("keeps nothing extra when no page is visible and the budget is zero", () => {
    expect(live(["a", "b"], null, 0)).toEqual([]);
  });

  it("fills the budget from the hidden pages when none is visible", () => {
    expect(live(["a", "b", "c"], null, 2)).toEqual(["a", "b"]);
  });

  it("does not spend the budget twice on a duplicated page", () => {
    expect(live(["a", "b", "b", "c", "d"], "a", 2)).toEqual(["a", "b", "c"]);
  });

  it("keeps everything when there is room", () => {
    expect(live(["a", "b", "c"], "a", DEFAULT_KEEP)).toEqual(["a", "b", "c"]);
  });

  it("defaults to six hidden guests", () => {
    const order = Array.from({ length: 10 }, (_, n) => `p${n}`);
    expect(liveGuests({ order, visible: "p0", keep: DEFAULT_KEEP, pinned: none }).size).toBe(7);
  });
});
