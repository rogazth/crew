import { describe, expect, it } from "vitest";
import { fitScale, GUTTER, MAX_SCALE, MIN_SCALE, stepScale } from "./imageZoom";

const pane = (width: number, height: number) => ({ width: width + GUTTER * 2, height: height + GUTTER * 2 });

describe("fitScale", () => {
  it("shrinks a large image to the pane, by its tighter side", () => {
    expect(fitScale({ width: 2000, height: 1000 }, pane(1000, 1000))).toBe(0.5);
    expect(fitScale({ width: 1000, height: 2000 }, pane(1000, 500))).toBe(0.25);
  });

  it("never enlarges a small one", () => {
    expect(fitScale({ width: 16, height: 16 }, pane(1000, 1000))).toBe(1);
  });

  it("is 1 before the image or the pane has a size", () => {
    expect(fitScale({ width: 0, height: 0 }, pane(1000, 1000))).toBe(1);
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBeGreaterThan(0);
  });
});

describe("stepScale", () => {
  it("steps to the next stop either way", () => {
    expect(stepScale(1, 1)).toBe(1.5);
    expect(stepScale(1, -1)).toBe(0.75);
  });

  it("snaps a fitted scale between stops to the stop past it", () => {
    expect(stepScale(0.37, 1)).toBe(0.5);
    expect(stepScale(0.37, -1)).toBe(0.25);
  });

  it("stays at either end", () => {
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
});
