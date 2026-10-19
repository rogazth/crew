import { describe, expect, it } from "vitest";
import { accentFromDirection, DEFAULT_ACCENT, parseAccent } from "./accent";

describe("accent", () => {
  it("knows the three palettes and falls back to Ink", () => {
    expect(parseAccent("teal")).toBe("teal");
    expect(parseAccent("cobalt")).toBe("cobalt");
    expect(parseAccent("ink")).toBe("ink");
    expect(parseAccent("crew")).toBe(DEFAULT_ACCENT);
    expect(parseAccent(null)).toBe(DEFAULT_ACCENT);
  });

  it("maps the old direction keys onto the new names", () => {
    expect(accentFromDirection("a")).toBe("ink");
    expect(accentFromDirection("b")).toBe("teal");
    expect(accentFromDirection("c")).toBe("cobalt");
    expect(accentFromDirection("off")).toBeNull();
    expect(accentFromDirection(null)).toBeNull();
  });
});
