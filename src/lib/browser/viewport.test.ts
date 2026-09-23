import { describe, expect, it } from "vitest";
import { clampSide, preset, presetOf, VIEWPORT_LIMITS } from "./viewport";

describe("viewport", () => {
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
