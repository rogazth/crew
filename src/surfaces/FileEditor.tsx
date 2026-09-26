import { lazy, Suspense, type ReactNode } from "react";
import { ListBulletsIcon } from "@phosphor-icons/react";
import { Button } from "../chrome/kit";
import { useCommands } from "../hooks/useCommand";
import { useOutlinePref } from "../hooks/useOutlinePref";
import { useTextFile } from "../hooks/useTextFile";
import { commandKeys } from "../lib/commands";
import { TOKENIZE_MAX_LENGTH } from "../lib/highlighting";
import type { ProjectFile } from "../lib/types";
import { NoPreview } from "./NoPreview";

type Props = {
  path: string;
  relative: string;
  /** The workspace index, which `[[wikilinks]]` resolve against. */
  files: ProjectFile[];
  onOpenPath: (path: string) => void;
  /** Sits at the header's right end: a page file's Preview/Source switch. */
  actions?: ReactNode;
};

/** Each editor loads only when a file needs it: diffs and its highlighter are ~600 kB, CodeMirror ~330 kB. */
const CodeEditor = lazy(() => import("./editor/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const MarkdownEditor = lazy(() =>
  import("./editor/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })),
);

const MARKDOWN = /\.(?:md|markdown)$/i;

export function FileEditor({ path, relative, files, onOpenPath, actions }: Props) {
  const name = relative.split("/").pop() ?? relative;
  const isMarkdown = MARKDOWN.test(name);
  const { loaded, revision, dirty, conflict, error, setContents, reload, overwrite } = useTextFile(path);
  const [outline, toggleOutline] = useOutlinePref();
  useCommands(isMarkdown ? { "toggle-outline": toggleOutline } : {});

  // The daemon reads text only; anything else says so in Rust's words.
  if (error?.includes("valid UTF-8")) return <NoPreview path={path} relative={relative} />;
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
        {isMarkdown && (
          <button
            type="button"
            aria-label="Outline"
            title="Outline"
            aria-pressed={outline}
            onClick={toggleOutline}
            className="-mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-hover hover:text-kumo-default aria-pressed:text-kumo-default"
          >
            <ListBulletsIcon className="size-4" />
          </button>
        )}
        {actions}
      </div>

      {/* The disk and the editor both changed: the edits stay, and nothing is
          written until one side is chosen. */}
      {conflict && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border bg-sidebar px-4 py-1.5">
          <span className="truncate">Changed on disk</span>
          <Button className="ml-auto" onClick={reload}>
            Reload
          </Button>
          <Button onClick={overwrite}>
            Overwrite
          </Button>
        </div>
      )}

      {/* The editors scroll their own root and need a definite box to size the
          virtual window against — `flex-1` alone leaves it at auto height, which
          kills both scrolling and the virtualiser. */}
      <div data-selectable className="min-h-0 flex-1 overflow-hidden">
        {/* A new revision is the disk's text taken over the editor's: a fresh view. */}
        <Suspense fallback={null}>
          {isMarkdown ? (
            <MarkdownEditor
              key={revision}
              path={path}
              loaded={loaded}
              onChange={setContents}
              files={files}
              onOpenPath={onOpenPath}
              outline={outline}
            />
          ) : (
            <CodeEditor key={revision} path={path} name={name} loaded={loaded} onChange={setContents} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
