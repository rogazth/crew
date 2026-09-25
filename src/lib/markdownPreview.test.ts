import { describe, expect, it } from "vitest";
import { ensureSyntaxTree, LanguageSupport } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { previewDecorations } from "./markdownPreview";

function stateOf(doc: string, caret = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: new LanguageSupport(markdownLanguage),
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

  it("keeps a code block's contents verbatim", () => {
    const doc = "```ts\nconst a = `**b**`;\n```";
    expect(rendered(doc, null)).toBe(doc);
  });
});
