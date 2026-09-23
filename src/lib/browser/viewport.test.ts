import { describe, expect, it } from "vitest";
import { clampSide, preset, presetOf, rotate, VIEWPORT_LIMITS } from "./viewport";

describe("viewport", () => {
  it("rotates and still knows its preset", () => {
    const phone = preset("phone");
    expect(rotate(phone)).toEqual({ width: 844, height: 390 });
    expect(presetOf(rotate(phone))).toBe("phone");
    expect(presetOf({ width: 500, height: 500 })).toBeNull();
  });

  it("clamps a typed side and ignores what isn't a number", () => {
    expect(clampSide(100, 390)).toBe(VIEWPORT_LIMITS.min);
    expect(clampSide(99999, 390)).toBe(VIEWPORT_LIMITS.max);
    expect(clampSide(412.6, 390)).toBe(413);
    expect(clampSide(Number.NaN, 390)).toBe(390);
  });
});
