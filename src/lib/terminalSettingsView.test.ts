import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_PREFS, LIMITS } from "./terminalPrefs";
import { commitStep, ligaturesNote, nudge, snap, zoomed } from "./terminalSettingsView";

describe("snap", () => {
  it("rounds to the step without float noise", () => {
    expect(snap(1.2000000001, 0.1, LIMITS.lineHeight)).toBe(1.2);
    expect(snap(1 + 0.1 + 0.1, 0.1, LIMITS.lineHeight)).toBe(1.2);
    expect(snap(449, 100, LIMITS.fontWeight)).toBe(400);
    expect(snap(450, 100, LIMITS.fontWeight)).toBe(500);
  });

  it("clamps into the limits", () => {
    expect(snap(99, 1, LIMITS.fontSize)).toBe(32);
    expect(snap(2, 1, LIMITS.fontSize)).toBe(8);
  });
});

describe("commitStep", () => {
  it("commits a typed value, snapped and clamped", () => {
    expect(commitStep("15", 14, 1, LIMITS.fontSize)).toEqual({ draft: "15", commit: 15 });
    expect(commitStep("1.24", 1, 0.1, LIMITS.lineHeight)).toEqual({ draft: "1.2", commit: 1.2 });
    expect(commitStep("100", 14, 1, LIMITS.fontSize)).toEqual({ draft: "32", commit: 32 });
  });

  it("shows the snapped value but commits nothing when it lands where it was", () => {
    expect(commitStep("14.4", 14, 1, LIMITS.fontSize)).toEqual({ draft: "14", commit: null });
  });

  it("restores the current value when the field holds no number", () => {
    expect(commitStep("abc", 14, 1, LIMITS.fontSize)).toEqual({ draft: "14", commit: null });
    expect(commitStep("Infinity", 14, 1, LIMITS.fontSize)).toEqual({ draft: "14", commit: null });
  });
});

describe("nudge", () => {
  it("steps up and down within the limits", () => {
    expect(nudge(14, 1, 1, LIMITS.fontSize)).toBe(15);
    expect(nudge(14, -1, 1, LIMITS.fontSize)).toBe(13);
    expect(nudge(1.2, 1, 0.1, LIMITS.lineHeight)).toBe(1.3);
    expect(nudge(900, 1, 100, LIMITS.fontWeight)).toBe(900);
    expect(nudge(8, -1, 1, LIMITS.fontSize)).toBe(8);
  });
});

describe("ligaturesNote", () => {
  it("says what auto does for the chosen font", () => {
    expect(ligaturesNote({ ...DEFAULT_TERMINAL_PREFS, fontFamily: "Fira Code", ligatures: "off" })).toBe(
      'Auto turns them on for "Fira Code".',
    );
    expect(ligaturesNote({ ...DEFAULT_TERMINAL_PREFS, fontFamily: "Menlo", ligatures: "on" })).toBe(
      'Auto leaves them off for "Menlo".',
    );
  });
});

describe("zoomed", () => {
  const prefs = { ...DEFAULT_TERMINAL_PREFS, fontSize: 20, lineHeight: 1.4 };

  it("steps the font size and keeps the rest", () => {
    expect(zoomed(prefs, 1)).toEqual({ ...prefs, fontSize: 21 });
    expect(zoomed(prefs, -1)).toEqual({ ...prefs, fontSize: 19 });
  });

  it("stays inside the size limits", () => {
    expect(zoomed({ ...prefs, fontSize: LIMITS.fontSize.max }, 1).fontSize).toBe(LIMITS.fontSize.max);
    expect(zoomed({ ...prefs, fontSize: LIMITS.fontSize.min }, -1).fontSize).toBe(LIMITS.fontSize.min);
  });

  it("resets to the default size", () => {
    expect(zoomed(prefs, 0)).toEqual({ ...prefs, fontSize: DEFAULT_TERMINAL_PREFS.fontSize });
  });
});
