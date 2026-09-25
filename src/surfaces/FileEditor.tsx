import { lazy, Suspense } from "react";
import { useTextFile } from "../hooks/useTextFile";
import { commandKeys } from "../lib/commands";
import { TOKENIZE_MAX_LENGTH } from "../lib/highlighting";

type Props = { path: string; relative: string };

/** Each editor loads only when a file needs it: diffs and its highlighter are ~600 kB, CodeMirror ~330 kB. */
const CodeEditor = lazy(() => import("./editor/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const MarkdownEditor = lazy(() =>
  import("./editor/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

const MARKDOWN = /\.(?:md|markdown)$/i;

export function FileEditor({ path, relative }: Props) {
  const { loaded, saved, dirty, error, setContents } = useTextFile(path);

  const name = relative.split("/").pop() ?? relative;
  const isMarkdown = MARKDOWN.test(name);

  if (error) return <p className="p-4 text-red-600">{error}</p>;
  if (loaded === null) {
    return <p className="p-4 text-text-muted">Loading {name}…</p>;
  }

  const plain = !isMarkdown && loaded.length > TOKENIZE_MAX_LENGTH;

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

      {/* The editors scroll their own root and need a definite box to size the
          virtual window against — `flex-1` alone leaves it at auto height, which
          kills both scrolling and the virtualiser. */}
      <div data-selectable className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>
          {isMarkdown ? (
            <MarkdownEditor path={path} loaded={loaded} saved={saved} onChange={setContents} />
          ) : (
            <CodeEditor path={path} name={name} loaded={loaded} onChange={setContents} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
