import { describe, expect, it } from "vitest";
import { nextAccess } from "./sessionOptions";

describe("nextAccess", () => {
  it("cycles the provider's modes short of full", () => {
    expect(nextAccess("ask", ["ask", "edits", "auto", "full"])).toBe("edits");
    expect(nextAccess("auto", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("full", ["ask", "edits", "auto", "full"])).toBe("ask");
    expect(nextAccess("ask", ["ask", "full"])).toBeNull();
  });
});
