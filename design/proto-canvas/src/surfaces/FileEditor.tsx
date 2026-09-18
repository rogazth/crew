import { useEffect, useMemo, useRef, useState } from "react";
import { commandKeys, diffs } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { HighlightedLine, langFromPath } from "@/lib/highlight";
import { useStore } from "@/lib/store";
import { Badge } from "@/ui/Badge";
import { Icon } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Segmented } from "@/ui/Segmented";
import { Diff, tallyPatch } from "./DiffView";

const LINE_HEIGHT = 20;
const OVERSCAN = 12;
const PLAIN_TEXT_AT = 1500;

export function FileEditor({ relative }: { relative: string }) {
  const { fileCache, fileEdits, loadFile, editFile, saveFile } = useStore();
  const [view, setView] = useState<"file" | "diff">("file");
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => loadFile(relative), [relative, loadFile]);

  const base = fileCache[relative];
  const draft = fileEdits[relative];
  const content = draft ?? base ?? "";
  const dirty = draft !== undefined && draft !== base;

  const lines = useMemo(() => content.split("\n"), [content]);
  const lang = langFromPath(relative);
  const plain = lines.length > PLAIN_TEXT_AT;
  const patch = diffs.find((entry) => entry.path === relative);

  const first = Math.max(0, Math.floor(top / LINE_HEIGHT) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((top + height) / LINE_HEIGHT) + OVERSCAN);
  const rows = lines.slice(first, last);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-[var(--line-soft)] px-4">
        <Icon name="fileCode" size={14} className="shrink-0 text-ink-38" />
        <span className="truncate font-mono text-sm text-ink-70">{relative}</span>
        {dirty && <span className="size-2 shrink-0 rounded-full bg-accent" title="Unsaved changes" />}
        {plain && <Badge tone="warn">plain text</Badge>}
        <span className="flex-1" />
        {patch && (
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "file", label: "File" },
              { value: "diff", label: `Diff` },
            ]}
          />
        )}
        <button
          type="button"
          onClick={() => saveFile(relative)}
          disabled={!dirty}
          className="rise-1 flex h-7 items-center gap-1.5 rounded-chip px-2 text-sm text-ink-52 hover:bg-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          Save
          <Kbd>{commandKeys("save-file")}</Kbd>
        </button>
      </header>

      {view === "diff" && patch ? (
        <div className="scroller min-h-0 flex-1">
          <div className="flex items-center gap-2 border-b border-[var(--line-soft)] px-4 py-2 text-sm">
            <span className="text-[var(--added-ink)]">+{tallyPatch(patch.patch).added}</span>
            <span className="text-[var(--removed-ink)]">−{tallyPatch(patch.patch).removed}</span>
            <span className="text-ink-38">against HEAD</span>
          </div>
          <Diff patch={patch.patch} lang={lang} className="py-2" />
        </div>
      ) : (
        <div
          ref={scrollerRef}
          onScroll={(event) => {
            setTop(event.currentTarget.scrollTop);
            setHeight(event.currentTarget.clientHeight);
          }}
          className="scroller relative min-h-0 flex-1 bg-code-bg font-mono text-code"
        >
          <div className="relative" style={{ height: Math.max(lines.length * LINE_HEIGHT + 32, 200) }}>
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 w-12 select-none pr-3 text-right text-ink-38"
              style={{ transform: `translateY(${first * LINE_HEIGHT + 8}px)` }}
            >
              {rows.map((_line, index) => (
                <div key={first + index} style={{ height: LINE_HEIGHT }}>
                  {first + index + 1}
                </div>
              ))}
            </div>
            <pre
              aria-hidden
              className="pointer-events-none absolute left-12 right-0 top-0 whitespace-pre text-code-ink"
              style={{ transform: `translateY(${first * LINE_HEIGHT + 8}px)` }}
            >
              {rows.map((line, index) => (
                <div key={first + index} style={{ height: LINE_HEIGHT }}>
                  {plain ? line : <HighlightedLine line={line} lang={lang} />}
                </div>
              ))}
            </pre>
            <textarea
              spellCheck={false}
              value={content}
              onChange={(event) => editFile(relative, event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                  event.preventDefault();
                  saveFile(relative);
                }
              }}
              className={cx(
                "absolute inset-0 w-full resize-none overflow-hidden whitespace-pre bg-transparent pl-12 pt-2",
                "text-transparent caret-[var(--accent)] outline-none",
              )}
              style={{ lineHeight: `${LINE_HEIGHT}px`, fontFamily: "inherit", fontSize: "inherit" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
