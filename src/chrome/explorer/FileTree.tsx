import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRightIcon, LoaderIcon } from "lucide-react";
import { FileTypeIcon } from "../FileTypeIcon";
import { useFileTree } from "../../hooks/useFileTree";
import { useVirtualRows } from "../../hooks/useVirtualRows";
import { relativeTo, type TreeRow } from "../../lib/fileTree";
import type { ProjectFile } from "../../lib/types";

type Props = {
  root: string;
  /** The file on screen: marked, and its folders opened to show it. */
  active: string | null;
  /** On screen: the folders shown are listed again every few seconds. */
  live: boolean;
  /** A new token puts the keyboard here. */
  focusToken: number;
  tree: ReturnType<typeof useFileTree>;
  onOpenFile: (file: ProjectFile) => void;
};

const ROW = 24;
const INDENT = 12;

/** The workspace's folders, opened a level at a time, like VS Code's. */
export function FileTree({ root, active, live, focusToken, tree, onOpenFile }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const { rows, loaded, error, toggle, reveal } = tree;
  const { start, end, total, scrollToIndex } = useVirtualRows(scroller, rows.length, ROW);
  // The keyboard's row, by path: rows come and go under it as folders open.
  const [cursor, setCursor] = useState<string | null>(null);
  const at = cursor === null ? -1 : rows.findIndex((row) => row.entry.path === cursor);

  // Switching tabs shows where the file sits, as VS Code's autoReveal does.
  useEffect(() => {
    if (!live || !active || !active.startsWith(`${root}/`)) return;
    let cancelled = false;
    void reveal(active).then(() => {
      if (!cancelled) setCursor(active);
    });
    return () => {
      cancelled = true;
    };
  }, [active, root, live, reveal]);

  useEffect(() => {
    if (at >= 0) scrollToIndex(at);
  }, [at, scrollToIndex]);

  useEffect(() => {
    if (focusToken === 0) return;
    scroller.current?.focus();
  }, [focusToken]);

  function open(row: TreeRow) {
    setCursor(row.entry.path);
    if (row.entry.dir) toggle(row.entry.path);
    else onOpenFile({ path: row.entry.path, name: row.entry.name, relative: relativeTo(root, row.entry.path) });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const row = rows[at];
    const move = (index: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (next) setCursor(next.entry.path);
    };
    switch (event.key) {
      case "ArrowDown":
        move(at < 0 ? 0 : at + 1);
        break;
      case "ArrowUp":
        move(at < 0 ? 0 : at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row?.entry.dir) return;
        if (row.expanded) move(at + 1);
        else toggle(row.entry.path, true);
        break;
      case "ArrowLeft": {
        if (!row) return;
        if (row.expanded) {
          toggle(row.entry.path, false);
          break;
        }
        // To the folder it sits in: the nearest row above that is shallower.
        let parent = at - 1;
        while (parent >= 0 && rows[parent]!.depth >= row.depth) parent -= 1;
        if (parent >= 0) move(parent);
        break;
      }
      case "Enter":
      case " ":
        if (row) open(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div
      ref={scroller}
      role="tree"
      aria-label="Files"
      tabIndex={0}
      aria-activedescendant={at >= 0 ? rowId(at) : undefined}
      onKeyDown={onKeyDown}
      className="group/tree min-h-0 flex-1 overflow-y-auto py-1 outline-none"
    >
      {error ? (
        <p className="px-4 py-2 text-[12px] break-words text-danger">{error}</p>
      ) : (
        loaded && rows.length === 0 && <p className="px-4 py-2 text-[12px] text-placeholder">This folder is empty.</p>
      )}
      <div style={{ height: total }} className="relative">
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          const { entry } = row;
          return (
            <div
              key={entry.path}
              id={rowId(index)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={entry.dir ? row.expanded : undefined}
              aria-selected={entry.path === active}
              data-cursor={index === at || undefined}
              title={relativeTo(root, entry.path)}
              onClick={() => open(row)}
              style={{ top: index * ROW, height: ROW, paddingLeft: 8 + row.depth * INDENT }}
              className={`absolute inset-x-1 flex items-center gap-1.5 rounded-md pr-2 text-[13px] ${
                entry.ignored ? "text-text-muted" : ""
              } ${entry.path === active ? "bg-selected" : "hover:bg-hover"} group-focus/tree:data-cursor:ring-1 group-focus/tree:data-cursor:ring-focus/60`}
            >
              {entry.dir ? (
                row.loading ? (
                  <LoaderIcon className="size-3.5 shrink-0 animate-spin text-icon" />
                ) : (
                  <ChevronRightIcon
                    className={`size-3.5 shrink-0 text-icon transition-transform duration-100 ${row.expanded ? "rotate-90" : ""}`}
                  />
                )
              ) : (
                <FileTypeIcon name={entry.name} />
              )}
              <span className="min-w-0 truncate">{entry.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const rowId = (index: number) => `explorer-row-${index}`;
