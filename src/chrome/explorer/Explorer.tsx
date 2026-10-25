import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { PANEL, ROW } from "../kit";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { useFileTree } from "../../hooks/useFileTree";
import type { ExplorerFocus } from "../../hooks/useExplorer";
import type { ProjectFile } from "../../lib/types";

type Props = {
  /** The worktree on screen. */
  root: string;
  width: number;
  onResize: (width: number) => void;
  focus: ExplorerFocus | null;
  /** The file tab on screen. */
  active: string | null;
  onOpenFile: (file: ProjectFile) => void;
  /** The workspace's worktrees: with more than one, the header lets you pick which one it shows. */
  places?: { path: string; label: string }[];
  onRoot?: (path: string) => void;
};

const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

/**
 * VS Code's explorer, beside the tabs: one box over the worktree's files. Empty,
 * it shows the tree; with text, what the files say. The tree stays mounted
 * under a search, so it is as it was left once the box is cleared.
 */
export function Explorer({ root, width, onResize, focus, active, onOpenFile, places = [], onRoot }: Props) {
  const tree = useFileTree(root, true);
  const here = places.find((item) => item.path === root);
  // Hidden until asked for: by the button, or by ⌘⇧F, whose token is new each time.
  const [searching, setSearching] = useState(focus?.mode === "search");
  const [seen, setSeen] = useState(focus?.token);
  if (focus && focus.token !== seen) {
    setSeen(focus.token);
    if (focus.mode === "search") setSearching(true);
  }
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
        {places.length > 1 ? (
          <Menu.Root modal={false}>
            <Menu.Trigger
              title={root}
              className="-ml-0.5 flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-text outline-none transition-colors hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover"
            >
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
              <span className="truncate">{here?.label ?? "Worktree"}</span>
              <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-icon" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                <Menu.Popup className={PANEL}>
                  <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Show files of</div>
                  {places.map((item) => (
                    <Menu.Item key={item.path} className={ROW} onClick={() => item.path !== root && onRoot?.(item.path)}>
                      <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <CheckIcon className={`size-4 shrink-0 ${item.path === root ? "" : "invisible"}`} />
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : (
          <span className="px-1 text-[12px] font-medium text-text">Explorer</span>
        )}
        <div className="flex-1" />
        <HeaderButton icon={SearchIcon} label="Search" pressed={searching} onClick={() => setSearching((on) => !on)} />
        <HeaderButton icon={RefreshCwIcon} label="Refresh" onClick={() => void tree.refresh()} />
        <HeaderButton icon={CollapseAllIcon} label="Collapse folders" onClick={tree.collapseAll} />
      </div>

      <SearchPanel visible={searching} onClose={() => setSearching(false)} root={root} focus={focus?.mode === "search" ? focus : null} onOpenFile={onOpenFile}>
        <FileTree
          root={root}
          active={active}
          live
          focusToken={focus?.mode === "files" ? focus.token : 0}
          tree={tree}
          onOpenFile={onOpenFile}
        />
      </SearchPanel>

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

type IconType = (props: { className?: string }) => ReactNode;

/** VS Code's collapse-all: two stacked folders' worth of squares, minus inside. */
function CollapseAllIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M5.5 3.5V3a.5.5 0 0 1 .5-.5h6.5a1 1 0 0 1 1 1V10a.5.5 0 0 1-.5.5h-.5" />
      <rect x="2.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M4.5 9.5h4" />
    </svg>
  );
}

function HeaderButton({ icon: Glyph, label, onClick, pressed }: { icon: IconType; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      aria-pressed={pressed}
      className="aria-pressed:bg-selected aria-pressed:text-text grid size-6 shrink-0 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <Glyph className="size-4" />
    </button>
  );
}
