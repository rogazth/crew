import { describe, expect, it } from "vitest";
import { moveCursor } from "./picker";

describe("moveCursor", () => {
  it("steps down and up through the list", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, -1, 3)).toBe(1);
  });

  it("stops at the first and the last row", () => {
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, 1, 3)).toBe(2);
  });

  it("stays on 0 while the list is empty", () => {
    expect(moveCursor(0, 1, 0)).toBe(0);
    expect(moveCursor(0, -1, 0)).toBe(0);
  });

  it("comes back onto a list that shrank under it", () => {
    expect(moveCursor(7, -1, 3)).toBe(2);
  });
});
