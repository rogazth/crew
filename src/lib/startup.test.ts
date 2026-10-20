import { describe, expect, it } from "vitest";
import { parseReopen } from "./startup";

describe("parseReopen", () => {
  it("restores unless it was turned off", () => {
    expect(parseReopen(null)).toBe(true);
    expect(parseReopen("on")).toBe(true);
    expect(parseReopen(" off\n")).toBe(false);
  });
});
