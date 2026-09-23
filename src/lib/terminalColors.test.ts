import { describe, expect, it } from "vitest";
import { ANSI_DARK, ANSI_LIGHT, isOscColorQuery, oscColorReply, rgbToHex } from "./terminalColors";

describe("ANSI palettes", () => {
  it("define all sixteen colours as #rrggbb in both themes", () => {
    expect(Object.keys(ANSI_LIGHT)).toEqual(Object.keys(ANSI_DARK));
    expect(Object.keys(ANSI_DARK)).toHaveLength(16);
    for (const hex of [...Object.values(ANSI_DARK), ...Object.values(ANSI_LIGHT)]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("rgbToHex", () => {
  it("turns a computed rgb() into #rrggbb", () => {
    expect(rgbToHex("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(rgbToHex("rgb(29,36,40)")).toBe("#1d2428");
  });

  it("drops the alpha of rgba()", () => {
    expect(rgbToHex("rgba(1, 2, 3, 0.5)")).toBe("#010203");
  });

  it("passes anything else through", () => {
    expect(rgbToHex("#e8eef2")).toBe("#e8eef2");
    expect(rgbToHex("transparent")).toBe("transparent");
    expect(rgbToHex("")).toBe("");
  });
});

describe("OSC colour queries", () => {
  it("recognizes a query by its leading ?", () => {
    expect(isOscColorQuery("?")).toBe(true);
    expect(isOscColorQuery("rgb:ffff/0000/0000")).toBe(false);
    expect(isOscColorQuery("")).toBe(false);
  });

  it("answers in the rgb:rrrr/gggg/bbbb form, ST-terminated", () => {
    expect(oscColorReply(11, "#1d2428")).toBe("\x1b]11;rgb:1d1d/2424/2828\x1b\\");
    expect(oscColorReply(10, "e8eef2")).toBe("\x1b]10;rgb:e8e8/eeee/f2f2\x1b\\");
    expect(oscColorReply(12, "#FFFFFF")).toBe("\x1b]12;rgb:FFFF/FFFF/FFFF\x1b\\");
  });

  it("answers nothing for a colour that is not #rrggbb", () => {
    expect(oscColorReply(11, "#fff")).toBe("");
    expect(oscColorReply(11, "rgb(1, 2, 3)")).toBe("");
    expect(oscColorReply(11, "")).toBe("");
  });
});
