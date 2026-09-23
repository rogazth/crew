import { useCallback, useEffect, useMemo, useState } from "react";
import { Editor } from "@pierre/diffs/edit";
import { CodeView, EditProvider } from "@pierre/diffs/react";
import { useCommand } from "../hooks/useCommand";
import { commandKeys } from "../lib/commands";
import * as api from "../lib/api";
import { editorItems, fileName, isDirty } from "../lib/fileEditor";
import {
  THEME,
  TOKENIZE_MAX_LENGTH,
  TOKENIZE_MAX_LINE_LENGTH,
} from "../lib/highlighting";

type Props = { path: string; relative: string };

const OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  overflow: "scroll" as const,
  tokenizeMaxLength: TOKENIZE_MAX_LENGTH,
  tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
};

export function FileEditor({ path, relative }: Props) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [contents, setContents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const name = fileName(relative);
  const dirty = isDirty(loaded, saved, contents);

  useEffect(() => {
    let cancelled = false;
    api
      .readTextFile(path)
      .then((text) => {
        if (cancelled) return;
        setLoaded(text);
        setSaved(text);
        setContents(text);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.writeTextFile(path, contents);
      setSaved(contents);
      setWriteError(null);
    } catch (e) {
      setWriteError(String(e));
    } finally {
      setSaving(false);
    }
  }, [contents, dirty, path, saving]);

  useCommand("save-file", () => void save());

  // `contents` stays the text as read from disk: the editor owns the document from
  // here, and feeding it a new value without bumping `version` resets the session.
  const items = useMemo(() => editorItems(path, name, loaded), [loaded, name, path]);

  if (error) return <p className="p-4 text-red-600">{error}</p>;
  if (loaded === null) {
    return <p className="p-4 text-text-muted">Loading {name}…</p>;
  }

  const plain = loaded.length > TOKENIZE_MAX_LENGTH;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-text-muted">
        <span className="truncate">{relative}</span>
        {dirty && (
          <span className="flex shrink-0 items-center gap-1 text-accent">
            <span className="size-1.5 rounded-full bg-accent" />
            Unsaved
          </span>
        )}
        {writeError && (
          <span className="min-w-0 truncate text-red-600" role="alert">
            {writeError}
          </span>
        )}
        {plain && (
          <span className="shrink-0 rounded-md bg-sidebar px-1.5 py-0.5 text-[11px]">
            plain text
          </span>
        )}
        <kbd className="ml-auto shrink-0 text-[11px] text-placeholder">
          {commandKeys("save-file")}
        </kbd>
      </div>

      {/* CodeView scrolls its own root and needs a definite box to size the virtual
          window against — `flex-1` alone leaves it at auto height, which kills both
          scrolling and the virtualiser. The `overflow-auto` is on the root itself:
          the library listens for `scroll` there but never styles it. */}
      <div data-selectable className="min-h-0 flex-1 overflow-hidden">
        <EditProvider createEditor={(options) => new Editor(options)}>
          <CodeView
            items={items}
            options={OPTIONS}
            editorOptions={{ persistState: true }}
            className="h-full min-h-0 overflow-auto"
            onItemEditChange={(_item, file) => setContents(file.contents)}
          />
        </EditProvider>
      </div>
    </div>
  );
}
