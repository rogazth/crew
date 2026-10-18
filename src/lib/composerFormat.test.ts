import { describe, expect, it } from "vitest";
import { continueList, indentList, listItemAt, onIndentedListLine, onListLine, splitInlineCode, splitListMarkers, type TextEdit } from "./composerFormat";

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

describe("splitListMarkers", () => {
  const text = (value: string) => ({ kind: "text", text: value });
  const joined = (parts: { text: string }[]) => parts.map((part) => part.text).join("");

  it("takes the markers at line starts apart, keeping every character", () => {
    const parts = splitListMarkers([text("- a\n  2. b\nc - d")]);
    expect(parts).toEqual([
      { kind: "marker", text: "-" },
      { kind: "text", text: " a\n  " },
      { kind: "marker", text: "2." },
      { kind: "text", text: " b\nc - d" },
    ]);
    expect(joined(parts)).toBe("- a\n  2. b\nc - d");
  });
  it("needs the space after the marker", () => {
    expect(splitListMarkers([text("-a\n**b**")])).toEqual([text("-a\n**b**")]);
  });
  it("knows where lines start across mentions", () => {
    const mention = { kind: "mention", text: "@a.ts" };
    const parts = splitListMarkers([text("- see "), mention, text(" - not\n- yes")]);
    expect(parts).toEqual([
      { kind: "marker", text: "-" },
      text(" see "),
      mention,
      text(" - not\n"),
      { kind: "marker", text: "-" },
      text(" yes"),
    ]);
  });
  it("keeps a run's other fields", () => {
    expect(splitListMarkers([{ kind: "text", text: "- a", path: "x" }])).toEqual([
      { kind: "marker", text: "-" },
      { kind: "text", text: " a", path: "x" },
    ]);
  });
});

describe("splitInlineCode", () => {
  const text = (value: string) => ({ kind: "text", text: value });

  it("takes the backticks and the code apart, keeping every character", () => {
    const parts = splitInlineCode([text("run `npm test` now")]);
    expect(parts).toEqual([
      text("run "),
      { kind: "tick", text: "`" },
      { kind: "code", text: "npm test" },
      { kind: "tick", text: "`" },
      text(" now"),
    ]);
    expect(parts.map((part) => part.text).join("")).toBe("run `npm test` now");
  });
  it("leaves an unclosed or multi-line tick alone", () => {
    expect(splitInlineCode([text("a `b\nc` d")])).toEqual([text("a `b\nc` d")]);
  });
  it("never splits a mention", () => {
    const mention = { kind: "mention", text: "@a`b`" };
    expect(splitInlineCode([mention])).toEqual([mention]);
  });
});
