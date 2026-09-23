import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function on(platform: string) {
  vi.stubGlobal("navigator", { platform });
  return import("./menu");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("menu actions", () => {
  it("shows the platform's delete chord as the shortcut and marks delete as dangerous", async () => {
    const mac = await on("MacIntel");
    expect(mac.DELETE).toMatchObject({ id: "delete", hotkey: "⌘⌫", danger: true });
    vi.resetModules();
    const linux = await on("Linux x86_64");
    expect(linux.DELETE).toMatchObject({ id: "delete", hotkey: "Del", danger: true });
  });

  it("gives rename and edit single-key shortcuts", async () => {
    const { EDIT, RENAME } = await on("MacIntel");
    expect(RENAME).toMatchObject({ id: "rename", hotkey: "R" });
    expect(EDIT).toMatchObject({ id: "edit", hotkey: "E" });
    expect(RENAME.danger).toBeUndefined();
  });
});

describe("menuFromEvent", () => {
  it("claims the context-menu event and opens the menu where it happened", async () => {
    const { menuFromEvent } = await on("MacIntel");
    const event = { clientX: 120, clientY: 48, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    expect(menuFromEvent(event as unknown as MouseEvent)).toEqual({ x: 120, y: 48 });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
