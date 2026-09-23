import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function on(platform: string) {
  vi.stubGlobal("navigator", { platform });
  return import("./hotkey");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IS_MAC", () => {
  it("is true on macOS and iOS platforms", async () => {
    expect((await on("MacIntel")).IS_MAC).toBe(true);
    vi.resetModules();
    expect((await on("iPad")).IS_MAC).toBe(true);
  });

  it("is false elsewhere", async () => {
    expect((await on("Win32")).IS_MAC).toBe(false);
    vi.resetModules();
    expect((await on("Linux x86_64")).IS_MAC).toBe(false);
  });
});

describe("isDeleteChord", () => {
  it("is ⌘⌫ on macOS", async () => {
    const { isDeleteChord } = await on("MacIntel");
    expect(isDeleteChord({ key: "Backspace", metaKey: true })).toBe(true);
    expect(isDeleteChord({ key: "Backspace", metaKey: false })).toBe(false);
    expect(isDeleteChord({ key: "Delete", metaKey: false })).toBe(false);
  });

  it("is Delete elsewhere, with or without modifiers", async () => {
    const { isDeleteChord } = await on("Linux x86_64");
    expect(isDeleteChord({ key: "Delete", metaKey: false })).toBe(true);
    expect(isDeleteChord({ key: "Delete", metaKey: true })).toBe(true);
    expect(isDeleteChord({ key: "Backspace", metaKey: true })).toBe(false);
  });
});
