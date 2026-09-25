import { useMemo } from "react";
import { Editor } from "@pierre/diffs/edit";
import { CodeView, EditProvider } from "@pierre/diffs/react";
import {
  THEME,
  TOKENIZE_MAX_LENGTH,
  TOKENIZE_MAX_LINE_LENGTH,
} from "../../lib/highlighting";

type Props = { path: string; name: string; loaded: string; onChange: (contents: string) => void };

const OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  overflow: "scroll" as const,
  tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
  tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
};

export function CodeEditor({ path, name, loaded, onChange }: Props) {
  // One item, so CodeView is really "a virtualized File". A stable cacheKey and
  // id are what let the editor persist per-file state across tab switches.
  // `loaded` stays the text as read from disk: the editor owns the document from
  // here, and feeding it a new value without bumping `version` resets the session.
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
    <EditProvider createEditor={(options) => new Editor(options)}>
      <CodeView
        items={items}
        options={OPTIONS}
        editorOptions={{ persistState: true }}
        className="h-full min-h-0 overflow-auto"
        onItemEditChange={(_item, file) => onChange(file.contents)}
      />
    </EditProvider>
  );
}
