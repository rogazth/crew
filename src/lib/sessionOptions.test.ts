import { describe, expect, it } from "vitest";
import { nextEffort } from "./sessionOptions";

describe("nextEffort", () => {
  it("steps up through the model's levels and wraps to the lowest", () => {
    expect(nextEffort("low", ["low", "medium", "high"])).toBe("medium");
    expect(nextEffort("high", ["low", "medium", "high"])).toBe("low");
    expect(nextEffort("", ["low", "medium", "high"])).toBe("low");
    expect(nextEffort("high", ["high"])).toBeNull();
  });
});
