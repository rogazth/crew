import { useEffect, useMemo, useState } from "react";
import { Editor } from "@pierre/diffs/edit";
import { CodeView, EditProvider } from "@pierre/diffs/react";
import { editorSessions } from "../../lib/editorSessions";
import { onReveal, pendingReveal, type Reveal } from "../../lib/reveal";
import { onDiscard } from "../../lib/unsavedEdits";
import {
  THEME,
  TOKENIZE_MAX_LENGTH,
  TOKENIZE_MAX_LINE_LENGTH,
} from "../../lib/highlighting";

type Props = {
  path: string;
  name: string;
  /** The text to start from: the disk's, or edits kept from before the tab went away. */
  loaded: string;
  onChange: (contents: string) => void;
};

const OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  overflow: "scroll" as const,
  tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
  tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
};

/**
 * A tab switch unmounts the editor. With `persistState` an Editor keeps each
 * file's document, undo history, selection and scroll across its detach and
 * attach, but only for its own life: so each file keeps one Editor, which the
 * next mount attaches again while it still holds the text the file starts from.
 * Otherwise the library would put its cached document over `loaded`.
 */
const sessions = editorSessions<Editor<unknown>>(20);
// A close that discards a file's edits takes its undo history with them.
onDiscard((path) => sessions.drop(path));

export function CodeEditor({ path, name, loaded, onChange }: Props) {
  // Mounts show one file at a time (the Surface is keyed by path), so a file's
  // Editor is never attached twice.
  const [editor] = useState(() => sessions.take(path, loaded, () => new Editor({ persistState: true })));

  // A search result's match: on screen and selected, once the Editor has the document.
  useEffect(() => {
    let frame = 0;
    const reveal = (at: Reveal, tries = 30) => {
      cancelAnimationFrame(frame);
      try {
        const start = { line: at.line - 1, character: at.from };
        editor.focus({ lineNumber: at.line, character: at.from });
        editor.setSelections([{ start, end: { line: at.line - 1, character: at.to }, direction: "forward" }]);
      } catch {
        // Not attached yet: the document arrives with the CodeView's first paint.
        if (tries > 0) frame = requestAnimationFrame(() => reveal(at, tries - 1));
      }
    };
    const waiting = pendingReveal(path);
    if (waiting) frame = requestAnimationFrame(() => reveal(waiting));
    const off = onReveal(path, reveal);
    return () => {
      cancelAnimationFrame(frame);
      off();
    };
  }, [editor, path]);

  // One item, so CodeView is really "a virtualized File". A stable cacheKey and
  // id are what the Editor keeps the file's state under. `loaded` never changes
  // under a mount: the disk's text taken over the editor's is a new one.
  const items = useMemo(
    () => [
      {
        id: path,
        type: "file" as const,
        file: { name, contents: loaded, cacheKey: path },
        edit: true,
      },
    ],
    [loaded, name, path],
  );

  // The `overflow-auto` is on the root itself: the library listens for `scroll`
  // there but never styles it.
  return (
    <EditProvider
      createEditor={(options) => {
        // The options carry this CodeView's change listener.
        editor.setOptions(options);
        return editor;
      }}
    >
      <CodeView
        items={items}
        options={OPTIONS}
        editorOptions={{ persistState: true }}
        className="h-full min-h-0 overflow-auto"
        onItemEditChange={(_item, file) => {
          const contents = file.contents;
          sessions.edited(path, editor, contents);
          onChange(contents);
        }}
      />
    </EditProvider>
  );
}
