import { describe, expect, it } from "vitest";
import { matchLabel, searchKey } from "./terminalSearchView";

describe("searchKey", () => {
  it("closes on Escape, with or without Shift", () => {
    expect(searchKey("Escape", false)).toEqual({ kind: "close" });
    expect(searchKey("Escape", true)).toEqual({ kind: "close" });
  });

  it("walks forward on Enter and back on Shift+Enter", () => {
    expect(searchKey("Enter", false)).toEqual({ kind: "step", delta: 1 });
    expect(searchKey("Enter", true)).toEqual({ kind: "step", delta: -1 });
  });

  it("leaves every other key to the field", () => {
    expect(searchKey("a", false)).toBeNull();
    expect(searchKey("ArrowDown", true)).toBeNull();
  });
});

describe("matchLabel", () => {
  it("counts from one", () => {
    expect(matchLabel({ index: 0, count: 12 })).toBe("1 of 12");
    expect(matchLabel({ index: 11, count: 12 })).toBe("12 of 12");
  });

  it("says nothing without matches", () => {
    expect(matchLabel({ index: -1, count: 0 })).toBe("");
  });
});
