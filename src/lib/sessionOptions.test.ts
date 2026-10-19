import { describe, expect, it } from "vitest";
import { nextAccess, nextEffort } from "./sessionOptions";

describe("nextAccess", () => {
  it("cycles every mode the provider offers, full included", () => {
    expect(nextAccess("ask", ["ask", "edits", "auto", "full"])).toBe("edits");
    expect(nextAccess("auto", ["ask", "edits", "auto", "full"])).toBe("full");
    expect(nextAccess("full", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("ask", ["ask", "full"])).toBe("full");
    expect(nextAccess("ask", ["ask"])).toBeNull();
  });
});

describe("nextEffort", () => {
  it("steps up through the model's levels and wraps to the lowest", () => {
    expect(nextEffort("low", ["low", "medium", "high"])).toBe("medium");
    expect(nextEffort("high", ["low", "medium", "high"])).toBe("low");
    expect(nextEffort("", ["low", "medium", "high"])).toBe("low");
    expect(nextEffort("high", ["high"])).toBeNull();
  });
});
