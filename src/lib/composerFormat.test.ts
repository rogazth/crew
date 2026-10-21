import { describe, expect, it } from "vitest";
import { continueList, indentList, listItemAt, onIndentedListLine, onListLine, removeListMarker, type TextEdit } from "./composerFormat";

/** Applies an edit to a string, the caret written as `|` (or a selection as `[`…`]`). */
function run(edit: TextEdit | null, text: string): string | null {
  if (!edit) return null;
  const next = text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
  if (edit.selStart === edit.selEnd) return next.slice(0, edit.selStart) + "|" + next.slice(edit.selStart);
  return next.slice(0, edit.selStart) + "[" + next.slice(edit.selStart, edit.selEnd) + "]" + next.slice(edit.selEnd);
}

/** Reads `|` or `[`…`]` out of a string as the selection. */
function caret(marked: string): { text: string; start: number; end: number } {
  if (marked.includes("|")) {
    const at = marked.indexOf("|");
    return { text: marked.replace("|", ""), start: at, end: at };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { text: marked.replace("[", "").replace("]", ""), start, end };
}

const cont = (marked: string) => {
  const { text, start, end } = caret(marked);
  return run(continueList(text, start, end), text);
};
const indent = (marked: string, direction: 1 | -1) => {
  const { text, start, end } = caret(marked);
  return run(indentList(text, start, end, direction), text);
};

describe("listItemAt", () => {
  it("reads bullets, numbers, indent and task boxes", () => {
    expect(listItemAt("- a", 3)).toMatchObject({ indent: "", marker: "-", gap: " ", contentStart: 2 });
    expect(listItemAt("x\n  12) b", 5)).toMatchObject({ lineStart: 2, indent: "  ", marker: "12)", contentStart: 8 });
    expect(listItemAt("* [x] done", 0)).toMatchObject({ marker: "*", gap: " [x] " });
  });
  it("is not fooled by text that only looks like a marker", () => {
    expect(listItemAt("-a", 1)).toBeNull();
    expect(listItemAt("**bold**", 2)).toBeNull();
    expect(listItemAt("a - b", 4)).toBeNull();
    expect(listItemAt("1.5 is a number", 3)).toBeNull();
    expect(listItemAt("-", 1)).toBeNull();
  });
});

describe("continueList", () => {
  it("carries a bullet on", () => {
    expect(cont("- one|")).toBe("- one\n- |");
    expect(cont("* one|")).toBe("* one\n* |");
    expect(cont("+ one|")).toBe("+ one\n+ |");
  });
  it("keeps the indent and the spacing after the marker", () => {
    expect(cont("  - nested|")).toBe("  - nested\n  - |");
    expect(cont("\t-   wide|")).toBe("\t-   wide\n\t-   |");
  });
  it("counts numbers up, keeping the separator", () => {
    expect(cont("1. one|")).toBe("1. one\n2. |");
    expect(cont("9) nine|")).toBe("9) nine\n10) |");
  });
  it("starts a task box unticked", () => {
    expect(cont("- [x] done|")).toBe("- [x] done\n- [ ] |");
    expect(cont("- [ ] todo|")).toBe("- [ ] todo\n- [ ] |");
  });
  it("splits an item at the caret, the rest going to the new item", () => {
    expect(cont("- ab|cd")).toBe("- ab\n- |cd");
  });
  it("replaces a selection inside the item", () => {
    expect(cont("- a[bc]d")).toBe("- a\n- |d");
  });
  it("works on a line in the middle of the text", () => {
    expect(cont("intro\n- one|\nafter")).toBe("intro\n- one\n- |\nafter");
  });
  it("ends the list on an empty item, leaving the line empty", () => {
    expect(cont("- one\n- |")).toBe("- one\n|");
    expect(cont("- one\n  - |")).toBe("- one\n|");
    expect(cont("1. one\n2. |")).toBe("1. one\n|");
    expect(cont("- [ ] |")).toBe("|");
    expect(cont("- one\n-   |\nnext")).toBe("- one\n|\nnext");
  });
  it("leaves ordinary lines and carets in the marker to the textarea", () => {
    expect(cont("plain|")).toBeNull();
    expect(cont("|- one")).toBeNull();
    expect(cont("-| one")).toBeNull();
    expect(cont("")).toBeNull();
    expect(cont("- one\nplain|")).toBeNull();
  });
  it("leaves a selection that runs past the line to the textarea", () => {
    expect(cont("- o[ne\nmo]re")).toBeNull();
  });
});

describe("removeListMarker", () => {
  it("takes an empty item and the line break before it, at once", () => {
    expect(removeListMarker("1. Test\n2. ", 11)).toEqual({ start: 7, end: 11, insert: "", selStart: 7, selEnd: 7 });
    expect(removeListMarker("- a\n  - \nb", 8)).toEqual({ start: 3, end: 8, insert: "", selStart: 3, selEnd: 3 });
  });
  it("keeps an item's text as a plain line", () => {
    expect(removeListMarker("- a\n* b", 6)).toEqual({ start: 4, end: 6, insert: "", selStart: 4, selEnd: 4 });
  });
  it("on the first line, takes only the marker", () => {
    expect(removeListMarker("- ", 2)).toEqual({ start: 0, end: 2, insert: "", selStart: 0, selEnd: 0 });
  });
  it("leaves carets elsewhere and selections to the textarea", () => {
    expect(removeListMarker("- ab", 3)).toBeNull();
    expect(removeListMarker("- ab", 1)).toBeNull();
    expect(removeListMarker("- ab", 2, 4)).toBeNull();
    expect(removeListMarker("plain", 5)).toBeNull();
  });
});

describe("indentList", () => {
  it("indents a list item by two spaces, the caret moving with it", () => {
    expect(indent("- one|", 1)).toBe("  - one|");
    expect(indent("a\n1. x|y", 1)).toBe("a\n  1. x|y");
  });
  it("outdents by two spaces, or one tab, or what indent there is", () => {
    expect(indent("    - one|", -1)).toBe("  - one|");
    expect(indent("\t- one|", -1)).toBe("- one|");
    expect(indent(" - one|", -1)).toBe("- one|");
  });
  it("leaves an unindented item or a plain line alone", () => {
    expect(indent("- one|", -1)).toBeNull();
    expect(indent("plain|", 1)).toBeNull();
    expect(indent("  plain|", -1)).toBeNull();
  });
  it("moves every list line of a selection, as one edit", () => {
    expect(indent("- [a\ntext\n- b]", 1)).toBe("  - [a\ntext\n  - b]");
    expect(indent("  - [a\n  - b]", -1)).toBe("- [a\n- b]");
  });
  it("does not take in the line a selection ends at the start of", () => {
    expect(indent("- [a\n]- b", 1)).toBe("  - [a\n]- b");
  });
  it("lands a caret inside removed indent at the line start", () => {
    expect(indent(" | - one", -1)).toBe("|- one");
  });
});

describe("onListLine / onIndentedListLine", () => {
  it("tells list lines apart", () => {
    expect(onListLine("a\n- b", 4)).toBe(true);
    expect(onListLine("a\n- b", 1)).toBe(false);
    expect(onIndentedListLine("  - b", 3)).toBe(true);
    expect(onIndentedListLine("- b", 3)).toBe(false);
    expect(onIndentedListLine("  plain", 3)).toBe(false);
  });
});
