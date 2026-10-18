import { describe, expect, it } from "vitest";
import { nextAccess } from "./sessionOptions";

describe("nextAccess", () => {
  it("cycles every mode the provider offers, full included", () => {
    expect(nextAccess("ask", ["ask", "edits", "auto", "full"])).toBe("edits");
    expect(nextAccess("auto", ["ask", "edits", "auto", "full"])).toBe("full");
    expect(nextAccess("full", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("ask", ["ask", "full"])).toBe("full");
    expect(nextAccess("ask", ["ask"])).toBeNull();
  });
});
