import { describe, expect, it } from "vitest";
import { parseChord, STROKES_SCRIPT, typingStrokes } from "./press";

const bare = { alt: false, ctrl: false, meta: false, shift: false };

describe("parseChord", () => {
  it("presses a named key with its text, so Enter submits a form", () => {
    expect(parseChord("Enter", false)).toEqual({ key: "Enter", code: "Enter", keyCode: 13, text: "\r", ...bare });
    expect(parseChord("Escape", false)).toEqual({ key: "Escape", code: "Escape", keyCode: 27, ...bare });
  });

  it("holds modifiers, and a letter under Ctrl is a shortcut rather than text", () => {
    expect(parseChord("Control+Shift+K", false)).toEqual({
      key: "K",
      code: "KeyK",
      keyCode: 75,
      alt: false,
      ctrl: true,
      meta: false,
      shift: true,
    });
  });

  it("runs the editing shortcuts as commands, with ⌘ on macOS and Ctrl elsewhere", () => {
    expect(parseChord("Meta+A", true).command).toBe("selectAll");
    expect(parseChord("Cmd+Shift+Z", true).command).toBe("redo");
    expect(parseChord("Control+A", false).command).toBe("selectAll");
    expect(parseChord("Meta+A", false).command).toBeUndefined();
    expect(parseChord("Control+A", true).command).toBeUndefined();
  });

  it("takes the usual aliases, any case", () => {
    expect(parseChord("esc", false).key).toBe("Escape");
    expect(parseChord("Down", false).key).toBe("ArrowDown");
    expect(parseChord("cmd+option+i", false)).toMatchObject({ key: "i", meta: true, alt: true });
    expect(parseChord("Shift+Tab", false)).toMatchObject({ key: "Tab", shift: true });
    expect(parseChord("F5", false).keyCode).toBe(116);
    expect(parseChord("Space", false)).toMatchObject({ key: " ", text: " " });
  });

  it("types a shifted letter as its capital", () => {
    expect(parseChord("Shift+a", false)).toMatchObject({ key: "A", text: "A", code: "KeyA", shift: true });
  });

  it("refuses what it cannot press, saying what it can", () => {
    expect(() => parseChord("Hyper+A", false)).toThrow(/not a modifier/);
    expect(() => parseChord("Enterr", false)).toThrow(/not a key/);
    expect(() => parseChord("Meta+", false)).toThrow(/names no key/);
  });
});

describe("typingStrokes", () => {
  it("types each character, and a newline as Enter", () => {
    expect(typingStrokes("aB\n").map((s) => [s.key, s.text, s.shift])).toEqual([
      ["a", "a", false],
      ["B", "B", true],
      ["Enter", "\r", false],
    ]);
  });

  it("types characters no keyboard names", () => {
    expect(typingStrokes("é")[0]).toMatchObject({ key: "é", text: "é" });
  });
});

describe("STROKES_SCRIPT", () => {
  it("is a function expression the page can call with the strokes", () => {
    // Parsed here, run in the page; a syntax slip would only show up there.
    expect(() => new Function(`return ${STROKES_SCRIPT}`)).not.toThrow();
    expect(typeof new Function(`return ${STROKES_SCRIPT}`)()).toBe("function");
  });
});
