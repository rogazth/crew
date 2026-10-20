import { describe, expect, it } from "vitest";
import { toneOf } from "./tabStyle";

describe("toneOf", () => {
  it("bolds what waits on you and the news", () => {
    expect(toneOf("needs-input")).toEqual({ bold: true });
    expect(toneOf("done")).toEqual({ bold: true });
    expect(toneOf("error")).toEqual({ bold: true });
  });

  it("stays quiet for work that wants nothing, idle, and tabs without a session", () => {
    for (const status of ["working", "background", "idle", null] as const) {
      expect(toneOf(status)).toEqual({ bold: false });
    }
  });
});
