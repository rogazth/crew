import { describe, expect, it } from "vitest";
import { toneOf } from "./tabStyle";

describe("toneOf", () => {
  it("gives each status its own channel", () => {
    expect(toneOf("working")).toMatchObject({ ring: "spin", tint: false, badge: null });
    expect(toneOf("needs-input")).toMatchObject({ ring: "warning", tint: true, bold: true });
    expect(toneOf("done")).toMatchObject({ badge: "info", bold: true, ring: null });
    expect(toneOf("error")).toMatchObject({ badge: "danger", bold: true, ring: null });
  });

  it("stays quiet for idle and for tabs without a session", () => {
    for (const status of ["idle", null] as const) {
      expect(toneOf(status)).toEqual({ ring: null, tint: false, bold: false, badge: null });
    }
  });
});
