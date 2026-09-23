import { describe, expect, it } from "vitest";
import { resolveTerminalKey } from "./terminalKeys";

type Chord = Partial<{ type: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }>;

function key(name: string, chord: Chord = {}) {
  return {
    type: chord.type ?? "keydown",
    key: name,
    code: chord.code ?? "",
    metaKey: chord.meta ?? false,
    ctrlKey: chord.ctrl ?? false,
    altKey: chord.alt ?? false,
    shiftKey: chord.shift ?? false,
  };
}

const mac = { isMac: true, hasSelection: false };
const linux = { isMac: false, hasSelection: false };

describe("resolveTerminalKey on macOS with ⌘", () => {
  it("spells the readline line-editing keys", () => {
    expect(resolveTerminalKey(key("Backspace", { meta: true }), mac)).toEqual({ type: "input", data: "\x15" });
    expect(resolveTerminalKey(key("Delete", { meta: true }), mac)).toEqual({ type: "input", data: "\x0b" });
    expect(resolveTerminalKey(key("ArrowLeft", { meta: true }), mac)).toEqual({ type: "input", data: "\x01" });
    expect(resolveTerminalKey(key("ArrowRight", { meta: true }), mac)).toEqual({ type: "input", data: "\x05" });
  });

  it("scrolls to the top and bottom on ⌘↑ and ⌘↓", () => {
    expect(resolveTerminalKey(key("ArrowUp", { meta: true }), mac)).toEqual({ type: "scroll", to: "top" });
    expect(resolveTerminalKey(key("ArrowDown", { meta: true }), mac)).toEqual({ type: "scroll", to: "bottom" });
  });

  it("selects all on ⌘A", () => {
    expect(resolveTerminalKey(key("a", { meta: true }), mac)).toEqual({ type: "select-all" });
  });

  it("sends an interrupt on ⌘C over nothing and leaves the copy to the app over a selection", () => {
    expect(resolveTerminalKey(key("c", { meta: true }), mac)).toEqual({ type: "input", data: "\x03" });
    expect(resolveTerminalKey(key("c", { meta: true }), { isMac: true, hasSelection: true })).toEqual({ type: "app" });
  });

  it("hands every other ⌘ chord to the app", () => {
    expect(resolveTerminalKey(key("t", { meta: true }), mac)).toEqual({ type: "app" });
    expect(resolveTerminalKey(key("k", { meta: true }), mac)).toEqual({ type: "app" });
  });

  it("keeps ⌘ chords with another modifier for the app", () => {
    expect(resolveTerminalKey(key("ArrowLeft", { meta: true, shift: true }), mac)).toEqual({ type: "app" });
    expect(resolveTerminalKey(key("Backspace", { meta: true, alt: true }), mac)).toEqual({ type: "app" });
    expect(resolveTerminalKey(key("c", { meta: true, ctrl: true }), mac)).toEqual({ type: "app" });
  });

  it("swallows the keyup of a ⌘ chord so xterm never types the bare key", () => {
    expect(resolveTerminalKey(key("c", { type: "keyup", meta: true }), mac)).toEqual({ type: "app" });
    expect(resolveTerminalKey(key("Backspace", { type: "keypress", meta: true }), mac)).toEqual({ type: "app" });
  });
});

describe("resolveTerminalKey without ⌘", () => {
  it("leaves keyup and keypress to xterm", () => {
    expect(resolveTerminalKey(key("Enter", { type: "keyup", shift: true }), mac)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("Backspace", { type: "keypress", alt: true }), linux)).toEqual({ type: "xterm" });
  });

  it("sends ESC CR for ⇧⏎ so agents read a newline, not a submit", () => {
    expect(resolveTerminalKey(key("Enter", { shift: true }), mac)).toEqual({ type: "input", data: "\x1b\r" });
    expect(resolveTerminalKey(key("Enter", { shift: true }), linux)).toEqual({ type: "input", data: "\x1b\r" });
  });

  it("lets xterm encode ⇧⏎ itself when the kitty keyboard protocol is on", () => {
    expect(resolveTerminalKey(key("Enter", { shift: true }), { ...mac, kittyKeyboard: true })).toEqual({ type: "xterm" });
  });

  it("leaves ⏎ with more than Shift to xterm", () => {
    expect(resolveTerminalKey(key("Enter", { shift: true, ctrl: true }), linux)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("Enter"), linux)).toEqual({ type: "xterm" });
  });

  it("deletes a word back on Ctrl+Backspace", () => {
    expect(resolveTerminalKey(key("Backspace", { ctrl: true }), linux)).toEqual({ type: "input", data: "\x17" });
    expect(resolveTerminalKey(key("Backspace", { ctrl: true }), mac)).toEqual({ type: "input", data: "\x17" });
    expect(resolveTerminalKey(key("Backspace", { ctrl: true, shift: true }), linux)).toEqual({ type: "xterm" });
  });

  it("edits by word with ⌥ on every platform", () => {
    for (const platform of [mac, linux]) {
      expect(resolveTerminalKey(key("Backspace", { alt: true }), platform)).toEqual({ type: "input", data: "\x1b\x7f" });
      expect(resolveTerminalKey(key("Delete", { alt: true }), platform)).toEqual({ type: "input", data: "\x1bd" });
      expect(resolveTerminalKey(key("ArrowLeft", { alt: true }), platform)).toEqual({ type: "input", data: "\x1bb" });
      expect(resolveTerminalKey(key("ArrowRight", { alt: true }), platform)).toEqual({ type: "input", data: "\x1bf" });
    }
  });

  it("claims ⌥B, ⌥F and ⌥D by physical key on macOS, whatever character Option composed", () => {
    expect(resolveTerminalKey(key("∫", { alt: true, code: "KeyB" }), mac)).toEqual({ type: "input", data: "\x1bb" });
    expect(resolveTerminalKey(key("ƒ", { alt: true, code: "KeyF" }), mac)).toEqual({ type: "input", data: "\x1bf" });
    expect(resolveTerminalKey(key("∂", { alt: true, code: "KeyD" }), mac)).toEqual({ type: "input", data: "\x1bd" });
  });

  it("leaves Option free to compose accents on every other letter", () => {
    expect(resolveTerminalKey(key("´", { alt: true, code: "KeyE" }), mac)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("ArrowUp", { alt: true }), mac)).toEqual({ type: "xterm" });
  });

  it("leaves Alt+B, F and D to xterm off macOS", () => {
    expect(resolveTerminalKey(key("b", { alt: true, code: "KeyB" }), linux)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("f", { alt: true, code: "KeyF" }), linux)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("d", { alt: true, code: "KeyD" }), linux)).toEqual({ type: "xterm" });
  });

  it("leaves ⌥ with another modifier to xterm", () => {
    expect(resolveTerminalKey(key("ArrowLeft", { alt: true, shift: true }), mac)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("b", { alt: true, ctrl: true, code: "KeyB" }), mac)).toEqual({ type: "xterm" });
  });

  it("treats Meta off macOS as an ordinary key for xterm", () => {
    expect(resolveTerminalKey(key("c", { meta: true }), linux)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("Backspace", { meta: true }), linux)).toEqual({ type: "xterm" });
  });

  it("passes plain keys through to xterm", () => {
    expect(resolveTerminalKey(key("a"), mac)).toEqual({ type: "xterm" });
    expect(resolveTerminalKey(key("c", { ctrl: true }), linux)).toEqual({ type: "xterm" });
  });
});
