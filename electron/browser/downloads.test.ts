import { describe, expect, it } from "vitest";
import { stateOf, uniquePath } from "./downloads";

describe("uniquePath", () => {
  it("keeps the name when nothing has it", () => {
    expect(uniquePath("/d", "report.pdf", () => false)).toBe("/d/report.pdf");
  });

  it("numbers the name before its extension until one is free", () => {
    const taken = new Set(["/d/report.pdf", "/d/report (1).pdf"]);
    expect(uniquePath("/d", "report.pdf", (file) => taken.has(file))).toBe("/d/report (2).pdf");
  });

  it("numbers a name without an extension at its end", () => {
    const taken = new Set(["/d/LICENSE"]);
    expect(uniquePath("/d", "LICENSE", (file) => taken.has(file))).toBe("/d/LICENSE (1)");
  });
});

describe("stateOf", () => {
  const item = (state: "progressing" | "completed" | "cancelled" | "interrupted", paused = false) => ({
    getState: () => state,
    isPaused: () => paused,
  });

  it("says paused for a download that is held", () => {
    expect(stateOf(item("progressing", true))).toBe("paused");
    expect(stateOf(item("progressing"))).toBe("progressing");
  });

  it.each(["completed", "cancelled", "interrupted"] as const)("passes %s through", (state) => {
    expect(stateOf(item(state))).toBe(state);
  });
});
