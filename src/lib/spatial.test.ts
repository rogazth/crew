import { describe, expect, it } from "vitest";
import { nearest, type Box } from "./spatial";

const box = (left: number, top: number, w: number, h: number): Box => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

// A three-column grid of 60×60 tiles over two full-width rows.
const tiles = [box(0, 0, 60, 60), box(60, 0, 60, 60), box(120, 0, 60, 60), box(0, 60, 60, 60)];
const rows = [box(0, 130, 180, 32), box(0, 162, 180, 32)];
const all = [...tiles, ...rows];

describe("nearest", () => {
  it("moves along a grid line and stops at its end", () => {
    expect(nearest(all[0]!, all, "right")).toBe(1);
    expect(nearest(all[2]!, all, "right")).toBe(-1);
    expect(nearest(all[1]!, all, "left")).toBe(0);
  });

  it("goes down a column, then out of the grid onto the first row", () => {
    expect(nearest(all[0]!, all, "down")).toBe(3);
    expect(nearest(all[3]!, all, "down")).toBe(4);
    expect(nearest(all[2]!, all, "down")).toBe(4);
  });

  it("enters a grid from a row at its first tile", () => {
    expect(nearest(all[4]!, all, "up")).toBe(3);
  });

  it("walks rows one at a time", () => {
    expect(nearest(all[4]!, all, "down")).toBe(5);
    expect(nearest(all[5]!, all, "down")).toBe(-1);
  });
});
