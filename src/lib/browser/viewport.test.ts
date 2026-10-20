import { describe, expect, it } from "vitest";
import { clampSide, fitScale, preset, presetOf, VIEWPORT_LIMITS } from "./viewport";

describe("viewport", () => {
  it("shrinks a page that doesn't fit by its tighter side, and never enlarges one that does", () => {
    expect(fitScale({ width: 1280, height: 800 }, { width: 640, height: 800 })).toBe(0.5);
    expect(fitScale({ width: 390, height: 844 }, { width: 800, height: 422 })).toBe(0.5);
    expect(fitScale({ width: 390, height: 844 }, { width: 800, height: 900 })).toBe(1);
    expect(fitScale({ width: 390, height: 844 }, { width: 0, height: 0 })).toBe(1);
  });

  it("knows the preset a size came from, and none for a typed one", () => {
    expect(presetOf(preset("tablet"))).toBe("tablet");
    expect(presetOf({ width: 844, height: 390 })).toBeNull();
    expect(presetOf({ width: 500, height: 500 })).toBeNull();
  });

  it("clamps a typed side and ignores what isn't a number", () => {
    expect(clampSide(100, 390)).toBe(VIEWPORT_LIMITS.min);
    expect(clampSide(99999, 390)).toBe(VIEWPORT_LIMITS.max);
    expect(clampSide(412.6, 390)).toBe(413);
    expect(clampSide(Number.NaN, 390)).toBe(390);
  });
});
