import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_PREFS,
  LIMITS,
  SYSTEM_MONO,
  clamp,
  fontStack,
  ligaturesEnabled,
  parseTerminalPrefs,
  type TerminalPrefs,
} from "./terminalPrefs";

const prefs = (over: Partial<TerminalPrefs>): TerminalPrefs => ({ ...DEFAULT_TERMINAL_PREFS, ...over });
const stored = (value: unknown) => JSON.stringify(value);

describe("clamp", () => {
  it("keeps a value inside its limits", () => {
    expect(clamp(4, LIMITS.fontSize)).toBe(8);
    expect(clamp(40, LIMITS.fontSize)).toBe(32);
    expect(clamp(14, LIMITS.fontSize)).toBe(14);
    expect(clamp(8, LIMITS.fontSize)).toBe(8);
    expect(clamp(32, LIMITS.fontSize)).toBe(32);
  });
});

describe("fontStack", () => {
  it("reaches the system mono through ui-monospace, since SF Mono is not installed by name", () => {
    expect(fontStack(SYSTEM_MONO)).toBe("ui-monospace, Menlo, Monaco, monospace");
  });

  it("puts a chosen family first, quoted, with the system stack behind it", () => {
    expect(fontStack("JetBrains Mono")).toBe('"JetBrains Mono", ui-monospace, Menlo, Monaco, monospace');
  });
});

describe("ligaturesEnabled", () => {
  it("follows an explicit on or off whatever the font", () => {
    expect(ligaturesEnabled(prefs({ ligatures: "on", fontFamily: "Menlo" }))).toBe(true);
    expect(ligaturesEnabled(prefs({ ligatures: "off", fontFamily: "Fira Code" }))).toBe(false);
  });

  it("leaves ligatures off on auto for fonts that ship none", () => {
    expect(ligaturesEnabled(prefs({ ligatures: "auto", fontFamily: SYSTEM_MONO }))).toBe(false);
    expect(ligaturesEnabled(prefs({ ligatures: "auto", fontFamily: "Menlo" }))).toBe(false);
    expect(ligaturesEnabled(prefs({ ligatures: "auto", fontFamily: "Consolas" }))).toBe(false);
  });

  it("turns ligatures on in auto for any other font", () => {
    expect(ligaturesEnabled(prefs({ ligatures: "auto", fontFamily: "Fira Code" }))).toBe(true);
    expect(ligaturesEnabled(prefs({ ligatures: "auto", fontFamily: "JetBrains Mono" }))).toBe(true);
  });
});

describe("parseTerminalPrefs", () => {
  it("starts from the defaults when nothing is stored", () => {
    expect(parseTerminalPrefs(null)).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(parseTerminalPrefs("")).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("round-trips what the settings page saves", () => {
    const saved: TerminalPrefs = {
      fontSize: 16,
      fontFamily: "Fira Code",
      fontWeight: 400,
      fontWeightBold: 800,
      lineHeight: 1.4,
      ligatures: "off",
    };
    expect(parseTerminalPrefs(stored(saved))).toEqual(saved);
    expect(parseTerminalPrefs(stored(DEFAULT_TERMINAL_PREFS))).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("falls back to the defaults for corrupt JSON", () => {
    expect(parseTerminalPrefs("{fontSize: 16")).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(parseTerminalPrefs("null")).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("falls back per field for a value of the wrong shape", () => {
    expect(parseTerminalPrefs(stored([1, 2, 3]))).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(parseTerminalPrefs(stored(42))).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(
      parseTerminalPrefs(
        stored({ fontSize: "16", fontFamily: 7, fontWeight: null, fontWeightBold: {}, lineHeight: [2], ligatures: "yes" }),
      ),
    ).toEqual(DEFAULT_TERMINAL_PREFS);
  });

  it("keeps the good fields of a partial value", () => {
    expect(parseTerminalPrefs(stored({ fontSize: 18 }))).toEqual(prefs({ fontSize: 18 }));
    expect(parseTerminalPrefs(stored({ ligatures: "on" }))).toEqual(prefs({ ligatures: "on" }));
  });

  it("clamps numbers into their limits", () => {
    expect(
      parseTerminalPrefs(stored({ fontSize: 2, fontWeight: 50, fontWeightBold: 1200, lineHeight: 9 })),
    ).toEqual(prefs({ fontSize: 8, fontWeight: 100, fontWeightBold: 900, lineHeight: 3 }));
    expect(parseTerminalPrefs(stored({ fontSize: 99, lineHeight: 0.5 }))).toEqual(
      prefs({ fontSize: 32, lineHeight: 1 }),
    );
  });

  it("rejects numbers that are not finite", () => {
    expect(parseTerminalPrefs('{"fontSize": 1e999}').fontSize).toBe(DEFAULT_TERMINAL_PREFS.fontSize);
  });

  it("falls back to the system mono for a blank family", () => {
    expect(parseTerminalPrefs(stored({ fontFamily: "   " })).fontFamily).toBe(SYSTEM_MONO);
    expect(parseTerminalPrefs(stored({ fontFamily: "" })).fontFamily).toBe(SYSTEM_MONO);
  });
});
