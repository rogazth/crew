import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { ListCollapseIcon, RefreshCwIcon } from "lucide-react";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { useFileTree } from "../../hooks/useFileTree";
import type { ExplorerFocus, ExplorerMode } from "../../hooks/useExplorer";
import { commandKeys } from "../../lib/commands";
import type { ProjectFile } from "../../lib/types";

type Props = {
  /** The worktree on screen. */
  root: string;
  width: number;
  onResize: (width: number) => void;
  mode: ExplorerMode;
  onMode: (mode: ExplorerMode) => void;
  focus: ExplorerFocus | null;
  /** The file tab on screen. */
  active: string | null;
  onOpenFile: (file: ProjectFile) => void;
};

const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

const MODES: { mode: ExplorerMode; label: string; command: "toggle-explorer" | "search-files" }[] = [
  { mode: "files", label: "Files", command: "toggle-explorer" },
  { mode: "search", label: "Search", command: "search-files" },
];

/**
 * VS Code's explorer, beside the tabs: the worktree's files, and text in them.
 * Both halves stay mounted, so a search is still there after a look at the tree.
 */
export function Explorer({ root, width, onResize, mode, onMode, focus, active, onOpenFile }: Props) {
  const tree = useFileTree(root, mode === "files");
  const start = useRef<{ x: number; width: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!start.current) return;
    // Its edge is on the left: dragging left widens it.
    const next = start.current.width - (event.clientX - start.current.x);
    onResize(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next))));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    start.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <aside
      data-explorer
      aria-label="Explorer"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-sidebar"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-2">
        {/* The file header's Preview/Source toggle, so the two headers read as one. */}
        <div role="tablist" aria-label="Explorer" className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-card p-0.5">
          {MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              role="tab"
              aria-selected={mode === item.mode}
              title={`${item.label} (${commandKeys(item.command)})`}
              onClick={() => onMode(item.mode)}
              className="flex h-6 items-center rounded-[5px] px-2 text-[12px] text-text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 aria-selected:bg-canvas aria-selected:text-text aria-selected:shadow-sm"
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {mode === "files" && (
          <>
            <HeaderButton icon={RefreshCwIcon} label="Refresh" onClick={() => void tree.refresh()} />
            <HeaderButton icon={ListCollapseIcon} label="Collapse folders" onClick={tree.collapseAll} />
          </>
        )}
      </div>

      <div hidden={mode !== "files"} className="flex min-h-0 flex-1 flex-col">
        <FileTree
          root={root}
          active={active}
          live={mode === "files"}
          focusToken={focus?.mode === "files" ? focus.token : 0}
          tree={tree}
          onOpenFile={onOpenFile}
        />
      </div>
      <div hidden={mode !== "search"} className="flex min-h-0 flex-1 flex-col">
        <SearchPanel root={root} focus={focus?.mode === "search" ? focus : null} onOpenFile={onOpenFile} />
      </div>

      <button
        type="button"
        tabIndex={-1}
        aria-label="Resize explorer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onResize(280)}
        className="absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-border-strong active:after:bg-border-strong"
      />
    </aside>
  );
}

function HeaderButton({ icon: Glyph, label, onClick }: { icon: typeof RefreshCwIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <Glyph className="size-4" />
    </button>
  );
}
