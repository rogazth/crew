import { useCallback, useEffect, useMemo, useState } from "react";
import { Editor } from "@pierre/diffs/edit";
import { CodeView, EditProvider } from "@pierre/diffs/react";
import { useCommand } from "../hooks/useCommand";
import { commandKeys } from "../lib/commands";
import * as api from "../lib/api";
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
  const [contents, setContents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const name = relative.split("/").pop() ?? relative;
  const dirty = loaded !== null && contents !== loaded;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    api
      .readTextFile(path)
      .then((text) => {
        if (cancelled) return;
        setLoaded(text);
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
      setLoaded(contents);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [contents, dirty, path, saving]);

  useCommand("save-file", () => void save());

  // One item, so CodeView is really "a virtualized File". A stable cacheKey and
  // id are what let the editor persist per-file state across tab switches.
  const items = useMemo(
    () =>
      loaded === null
        ? []
        : [
            {
              id: path,
              type: "file" as const,
              file: { name, contents: loaded, cacheKey: path },
              edit: true,
            },
          ],
    [loaded, name, path],
  );

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
        {plain && (
          <span className="shrink-0 rounded-md bg-sidebar px-1.5 py-0.5 text-[11px]">
            plain text
          </span>
        )}
        <kbd className="ml-auto shrink-0 text-[11px] text-placeholder">
          {commandKeys("save-file")}
        </kbd>
      </div>

      {/* CodeView owns its scroll container, but it needs a definite box to
          size the virtual window against — `flex-1` alone leaves it at auto
          height, which kills both scrolling and the virtualiser. */}
      <div data-selectable className="min-h-0 flex-1 overflow-hidden">
        <EditProvider createEditor={(options) => new Editor(options)}>
          <CodeView
            items={items}
            options={OPTIONS}
            editorOptions={{ persistState: true }}
            className="h-full"
            onItemEditChange={(_item, file) => setContents(file.contents)}
          />
        </EditProvider>
      </div>
    </div>
  );
}
