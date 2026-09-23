import { describe, expect, it } from "vitest";
import { editorItems, fileName, isDirty } from "./fileEditor";

describe("fileName", () => {
  it("is the last segment of the relative path", () => {
    expect(fileName("src/lib/tabs.ts")).toBe("tabs.ts");
    expect(fileName("README.md")).toBe("README.md");
  });
});

describe("isDirty", () => {
  it("is never dirty before the file has been read", () => {
    expect(isDirty(null, "", "typed")).toBe(false);
  });

  it("is dirty while the editor differs from what was last saved", () => {
    expect(isDirty("a", "a", "ab")).toBe(true);
  });

  it("is clean once the edit matches the saved text again", () => {
    expect(isDirty("a", "ab", "ab")).toBe(false);
    expect(isDirty("a", "a", "a")).toBe(false);
  });
});

describe("editorItems", () => {
  it("has no item until the file has been read", () => {
    expect(editorItems("/w/a.ts", "a.ts", null)).toEqual([]);
  });

  it("is one editable file keyed by its path", () => {
    expect(editorItems("/w/a.ts", "a.ts", "x")).toEqual([
      { id: "/w/a.ts", type: "file", file: { name: "a.ts", contents: "x", cacheKey: "/w/a.ts" }, edit: true },
    ]);
  });

  it("keeps an empty file as an item", () => {
    expect(editorItems("/w/empty", "empty", "")).toHaveLength(1);
  });
});
