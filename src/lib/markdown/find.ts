import { SearchCursor } from "@codemirror/search";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorSelection, StateEffect, StateField, type EditorState, type Text } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * Find for the app's own find bar: case-insensitive matches painted in the
 * viewport, the current one being the selection. CodeMirror's search panel
 * is not used, so ⌘F looks the same over a note as over a terminal or page.
 */

export const setFindQuery = StateEffect.define<string>();

const query = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFindQuery)) value = effect.value;
    return value;
  },
});

const MAX_MATCHES = 5000;

function cursor(doc: Text, text: string, from = 0, to = doc.length) {
  return new SearchCursor(doc, text, from, to, (s) => s.toLowerCase());
}

/** Every match's start and end, up to a cap that keeps a huge note responsive. */
export function findMatches(state: EditorState, text: string): { from: number; to: number }[] {
  if (!text) return [];
  const out: { from: number; to: number }[] = [];
  const found = cursor(state.doc, text);
  while (!found.next().done && out.length < MAX_MATCHES) out.push({ from: found.value.from, to: found.value.to });
  return out;
}

/** Selects the match after (or before) the selection, wrapping around. Returns its index. */
export function stepFind(view: EditorView, text: string, delta: number): { index: number; count: number } {
  const matches = findMatches(view.state, text);
  if (!matches.length) return { index: 0, count: 0 };
  const { from, to } = view.state.selection.main;
  let index: number;
  if (delta > 0) {
    index = matches.findIndex((m) => m.from >= to && !(m.from === from && m.to === to));
    if (index < 0) index = 0;
  } else {
    index = matches.length - 1;
    while (index >= 0 && matches[index]!.to > from) index--;
    if (index < 0) index = matches.length - 1;
  }
  const match = matches[index]!;
  view.dispatch({
    selection: EditorSelection.single(match.from, match.to),
    effects: EditorView.scrollIntoView(match.from, { y: "center" }),
  });
  return { index, count: matches.length };
}

/** Where the selection sits among the matches, for the "3 of 12" counter. */
export function findPosition(state: EditorState, text: string): { index: number; count: number } {
  const matches = findMatches(state, text);
  const { from } = state.selection.main;
  const index = Math.max(0, matches.findIndex((m) => m.from >= from));
  return { index, count: matches.length };
}

const match = Decoration.mark({ class: "cm-md-find" });
const current = Decoration.mark({ class: "cm-md-find cm-md-find-current" });

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.startState.field(query) !== update.state.field(query)
      ) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const text = view.state.field(query);
      if (!text) return Decoration.none;
      const { main } = view.state.selection;
      const out = [];
      for (const { from, to } of view.visibleRanges) {
        const found = cursor(view.state.doc, text, Math.max(0, from - text.length), Math.min(view.state.doc.length, to + text.length));
        while (!found.next().done) {
          const { from: a, to: b } = found.value;
          out.push((a === main.from && b === main.to ? current : match).range(a, b));
        }
      }
      return Decoration.set(out, true);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const findHighlighting = [query, highlighter];
