import { describe, expect, it } from "vitest";
import { actionForKey, placeMenu } from "./actionMenu";
import { IS_MAC } from "./hotkey";
import { DELETE, EDIT, RENAME, type MenuAction } from "./menu";

const viewport = { width: 1000, height: 800 };
const menu = { width: 200, height: 100 };

describe("placeMenu", () => {
  it("opens at the cursor when the menu fits", () => {
    expect(placeMenu({ x: 100, y: 100 }, menu, viewport)).toEqual({ left: 100, top: 100 });
  });

  it("keeps an 8px margin from the right edge", () => {
    expect(placeMenu({ x: 792, y: 100 }, menu, viewport)).toEqual({ left: 792, top: 100 });
    expect(placeMenu({ x: 793, y: 100 }, menu, viewport)).toEqual({ left: 792, top: 100 });
  });

  it("flips above the cursor near the bottom edge", () => {
    expect(placeMenu({ x: 100, y: 750 }, menu, viewport)).toEqual({ left: 100, top: 650 });
  });

  it("never pushes the menu past the top-left margin", () => {
    const tall = { width: 1200, height: 900 };
    expect(placeMenu({ x: 50, y: 50 }, tall, viewport)).toEqual({ left: 8, top: 8 });
  });
});

describe("actionForKey", () => {
  const chord = IS_MAC ? { key: "Backspace", metaKey: true } : { key: "Delete", metaKey: false };
  const key = (value: string) => ({ key: value, metaKey: false });

  it("fires a row by its single-key hotkey, in either case", () => {
    expect(actionForKey([RENAME, DELETE], key("r"))).toBe(RENAME);
    expect(actionForKey([RENAME, DELETE], key("R"))).toBe(RENAME);
  });

  it("fires delete on the platform's delete chord", () => {
    expect(actionForKey([EDIT, DELETE], chord)).toBe(DELETE);
  });

  it("ignores the delete chord when the menu has no delete", () => {
    expect(actionForKey([EDIT], chord)).toBeNull();
  });

  it("ignores keys that match nothing", () => {
    expect(actionForKey([EDIT, DELETE], key("x"))).toBeNull();
  });

  it("ignores a disabled row", () => {
    const disabled: MenuAction = { ...EDIT, disabled: true };
    expect(actionForKey([disabled], key("e"))).toBeNull();
    expect(actionForKey([{ ...DELETE, disabled: true }], chord)).toBeNull();
  });
});
