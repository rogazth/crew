import { describe, expect, it } from "vitest";
import { renamedTo } from "./rename";

describe("renamedTo", () => {
  it("commits the trimmed name", () => {
    expect(renamedTo("old", "  new name  ")).toBe("new name");
  });

  it("refuses an empty or blank name", () => {
    expect(renamedTo("old", "")).toBeNull();
    expect(renamedTo("old", "   ")).toBeNull();
  });

  it("treats the starting name, padded or not, as no change", () => {
    expect(renamedTo("old", "old")).toBeNull();
    expect(renamedTo("old", " old ")).toBeNull();
  });

  it("counts a change of case as a rename", () => {
    expect(renamedTo("old", "Old")).toBe("Old");
  });
});
