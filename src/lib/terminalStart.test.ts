import { describe, expect, it } from "vitest";
import { gridStep, type GridGate } from "./terminalStart";

const closed: GridGate = { started: false, revealed: false };

describe("gridStep", () => {
  it("waits on a restored pane that has never been shown", () => {
    expect(gridStep(closed, false)).toEqual({ gate: closed, step: "wait" });
  });

  it("measures a pane that is on screen, and remembers it was", () => {
    const shown = gridStep(closed, true);
    expect(shown).toEqual({ gate: { started: false, revealed: true }, step: "fit" });
    // Still on screen after it has started: fit, so a later resize can land.
    expect(gridStep({ started: true, revealed: true }, true).step).toBe("fit");
  });

  it("starts a pane the user left before its grid could settle", () => {
    const shown = gridStep(closed, true);
    const left = gridStep(shown.gate, false);
    expect(left).toEqual({ gate: { started: true, revealed: true }, step: "start" });
    expect(gridStep(left.gate, false).step).toBe("wait");
  });

  it("starts out of sight when asked, before any frame has shown it", () => {
    const asked = gridStep({ started: false, revealed: true }, false);
    expect(asked.step).toBe("start");
    expect(asked.gate.started).toBe(true);
  });
});
