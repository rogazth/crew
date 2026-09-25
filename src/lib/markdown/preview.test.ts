import { describe, expect, it } from "vitest";
import { ensureSyntaxTree, LanguageSupport } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { blockPreview } from "./blocks";
import { previewDecorations } from "./preview";
import { obsidianMarkdown } from "./syntax";

function stateOf(doc: string, caret = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [new LanguageSupport(obsidianMarkdown), blockPreview],
  });
  ensureSyntaxTree(state, doc.length);
  return state;
}

/** The text a reader sees: replaced ranges dropped, widgets as `<widget>`. */
function rendered(doc: string, caret: number | null) {
  const state = stateOf(doc, caret ?? 0);
  const replaced = previewDecorations(state, 0, doc.length, caret !== null)
    // Line decorations are points and marks carry a class; what is left replaces.
    .filter((r) => r.from !== r.to && !r.value.spec.class)
    .sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const r of replaced) {
    out += doc.slice(at, r.from) + (r.value.spec.widget ? "<widget>" : "");
    at = r.to;
  }
  return out + doc.slice(at);
}

describe("previewDecorations", () => {
  it("hides the syntax away from the caret", () => {
    expect(rendered("# Title\n\nsome **bold** and `code`", null)).toBe("Title\n\nsome bold and code");
  });

  it("shows the syntax the caret touches", () => {
    const doc = "# Title\n\nsome **bold** text";
    expect(rendered(doc, 2)).toBe("# Title\n\nsome bold text");
    expect(rendered(doc, doc.indexOf("bold"))).toBe("Title\n\nsome **bold** text");
  });

  it("renders a link as its text", () => {
    expect(rendered("see [docs](https://x.dev) here", null)).toBe("see docs here");
  });

  it("leaves a bracketed word that is not a link alone", () => {
    expect(rendered("an [aside] here", null)).toBe("an [aside] here");
  });

  it("swaps bullets and task markers for widgets", () => {
    expect(rendered("- one\n- [x] done", null)).toBe("<widget> one\n<widget> done");
  });

  it("keeps a code block's contents verbatim and quiets its fences", () => {
    const doc = "```ts\nconst a = `**b**`;\n```";
    expect(rendered(doc, null)).toBe("<widget>\nconst a = `**b**`;\n");
    expect(rendered(doc, 2)).toBe(doc);
  });

  it("renders a highlight as its text", () => {
    expect(rendered("a ==big== deal", null)).toBe("a big deal");
  });

  it("shows a wikilink's alias, or its target", () => {
    expect(rendered("see [[Plan#Goals|the plan]]", null)).toBe("see the plan");
    expect(rendered("see [[Plan]]", null)).toBe("see Plan");
  });

  it("swaps a callout's marker for its head", () => {
    expect(rendered("> [!warning] Careful\n> body", null)).toBe("<widget>Careful\nbody");
  });

  it("renders an image in place of its markdown", () => {
    expect(rendered("![alt](img.png) after", null)).toBe("<widget> after");
  });
});
