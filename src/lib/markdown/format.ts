// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorSelection, type StateCommand } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorView, type KeyBinding } from "@codemirror/view";
import { moveInTable } from "./table";

/**
 * Formatting the way Obsidian does it: a shortcut toggles a marker around the
 * selection (or the word at the caret), and typing a marker over a selection
 * wraps it instead of replacing it.
 */

/** Wraps each range in `marker`, or unwraps it when it already is. */
export function toggleMarker(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const size = marker.length;
    const change = state.changeByRange((range) => {
      let { from, to } = range;
      if (range.empty) {
        const word = state.wordAt(range.head);
        if (word) ({ from, to } = word);
      }
      const before = state.sliceDoc(from - size, from);
      const after = state.sliceDoc(to, to + size);
      // Already wrapped from outside: `**|bold|**`.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: from - size, to: from },
            { from: to, to: to + size },
          ],
          range: EditorSelection.range(range.anchor - size, range.head - size),
        };
      }
      // Wrapped from inside: `|**bold**|`.
      const text = state.sliceDoc(from, to);
      if (text.length >= size * 2 && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from, to, insert: text.slice(size, -size) },
          range: EditorSelection.range(from, to - size * 2),
        };
      }
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: range.empty && from === to
          ? EditorSelection.cursor(from + size)
          : EditorSelection.range(range.anchor + size, range.head + size),
      };
    });
    dispatch(state.update(change, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

const WRAPPING = new Set(["*", "_", "`", "=", "~"]);

/** Typing a marker with text selected wraps it and keeps it selected: `*` twice makes it bold. */
export const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (!WRAPPING.has(text) || state.selection.ranges.some((r) => r.empty) || from === to) return false;
  view.dispatch(
    state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: text },
        { from: range.to, insert: text },
      ],
      range: EditorSelection.range(range.anchor + 1, range.head + 1),
    })),
    { userEvent: "input.type" },
  );
  return true;
});

function tableMove(move: "next" | "prev" | "down"): StateCommand {
  return ({ state, dispatch }) => {
    const spec = moveInTable(state, move);
    if (!spec) return false;
    dispatch(state.update(spec));
    return true;
  };
}

/**
 * ⌘B takes over the app's sidebar toggle while a note has focus, as it does in
 * every editor with bold; ⌘K stays the command palette.
 */
export const formatKeymap: KeyBinding[] = [
  { key: "Mod-b", run: toggleMarker("**"), stopPropagation: true },
  { key: "Mod-i", run: toggleMarker("*"), stopPropagation: true },
  { key: "Mod-Shift-x", run: toggleMarker("~~"), stopPropagation: true },
  { key: "Mod-Shift-h", run: toggleMarker("=="), stopPropagation: true },
  { key: "Mod-e", run: toggleMarker("`"), stopPropagation: true },
  { key: "Tab", run: tableMove("next") },
  { key: "Shift-Tab", run: tableMove("prev") },
  { key: "Enter", run: tableMove("down") },
];
