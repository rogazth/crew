import { describe, expect, it } from "vitest";
import { toneOf } from "./tabStyle";

describe("toneOf", () => {
  it("tints only what waits on you and bolds the news", () => {
    expect(toneOf("needs-input")).toEqual({ tint: true, bold: true });
    expect(toneOf("done")).toEqual({ tint: false, bold: true });
    expect(toneOf("error")).toEqual({ tint: false, bold: true });
  });

  it("stays quiet for work that wants nothing, idle, and tabs without a session", () => {
    for (const status of ["working", "background", "idle", null] as const) {
      expect(toneOf(status)).toEqual({ tint: false, bold: false });
    }
  });
});
