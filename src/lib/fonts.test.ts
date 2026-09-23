import { afterEach, describe, expect, it, vi } from "vitest";
import { installedMonoFonts } from "./fonts";
import { SYSTEM_MONO } from "./terminalPrefs";

/**
 * A 2D canvas that measures text by the first font family in `ctx.font` it
 * has: an installed family gets its own width, anything else falls back to
 * the generic at the end of the stack.
 */
function canvasWith(installed: Record<string, { mono: number; serif: number } | number>) {
  const ctx = {
    font: "",
    measureText: vi.fn(() => {
      const stack = ctx.font.replace(/^72px /, "");
      const [first, generic] = stack.split(", ");
      const family = first!.replace(/"/g, "");
      const fallback = (generic ?? family) === "serif" ? 1100 : 1000;
      const width = installed[family];
      if (width === undefined) return { width: fallback };
      return { width: typeof width === "number" ? width : generic === "serif" ? width.serif : width.mono };
    }),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => ({ getContext: () => ctx })) });
  return ctx;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installedMonoFonts", () => {
  it("lists the system mono first, then every candidate that measures unlike the fallbacks", () => {
    canvasWith({ Menlo: 900, "Fira Code": 950, "JetBrains Mono": 1050 });
    expect(installedMonoFonts()).toEqual([SYSTEM_MONO, "Menlo", "JetBrains Mono", "Fira Code"]);
  });

  it("counts a font that only differs from the serif fallback", () => {
    canvasWith({ Hack: { mono: 1000, serif: 1000 } });
    expect(installedMonoFonts()).toEqual([SYSTEM_MONO, "Hack"]);
  });

  it("counts a font that only differs from the monospace fallback", () => {
    canvasWith({ Iosevka: { mono: 800, serif: 1100 } });
    expect(installedMonoFonts()).toEqual([SYSTEM_MONO, "Iosevka"]);
  });

  it("offers only the system mono when no candidate is installed", () => {
    canvasWith({ "Comic Mono": 700 });
    expect(installedMonoFonts()).toEqual([SYSTEM_MONO]);
  });

  it("offers only the system mono when there is no 2D canvas to measure with", () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(installedMonoFonts()).toEqual([SYSTEM_MONO]);
  });

  it("measures at a large size with the candidate quoted ahead of the fallback", () => {
    const ctx = canvasWith({});
    const fonts: string[] = [];
    ctx.measureText.mockImplementation(() => {
      fonts.push(ctx.font);
      return { width: 1000 };
    });
    installedMonoFonts();
    expect(fonts.slice(0, 4)).toEqual(["72px monospace", "72px serif", '72px "Menlo", monospace', '72px "Menlo", serif']);
  });
});
