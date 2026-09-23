import { describe, expect, it } from "vitest";
import { IS_MAC } from "./hotkey";
import { terminalActions } from "./terminalMenu";

describe("terminalActions", () => {
  it("offers copy, paste, select all and clear, in that order", () => {
    expect(terminalActions(true).map((action) => action.id)).toEqual(["copy", "paste", "select-all", "clear"]);
  });

  it("disables copy without a selection, and only copy", () => {
    const disabled = terminalActions(false).filter((action) => action.disabled);
    expect(disabled.map((action) => action.id)).toEqual(["copy"]);
    expect(terminalActions(true).some((action) => action.disabled)).toBe(false);
  });

  it("shows ⌘ shortcuts on macOS and Ctrl+ elsewhere", () => {
    expect(terminalActions(true, true).map((action) => action.hotkey)).toEqual(["⌘C", "⌘V", "⌘A", ""]);
    expect(terminalActions(true, false).map((action) => action.hotkey)).toEqual(["Ctrl+C", "Ctrl+V", "Ctrl+A", ""]);
  });

  it("reads the running platform by default", () => {
    expect(terminalActions(true)[0]!.hotkey).toBe(IS_MAC ? "⌘C" : "Ctrl+C");
  });
});
