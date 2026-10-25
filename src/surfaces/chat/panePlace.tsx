// The worktree the session on screen belongs to. A session nobody has written
// to yet can still move: its first screen shows the worktree as a fact that
// opens a searchable list of worktrees (⌥W from the composer), and picking one
// starts it there instead. A bot, a page or a tab with no place says nothing.
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ROW } from "../../chrome/kit";
import { fuzzyMatch } from "../../lib/fuzzy";
import { pickerKeyDown } from "../../chrome/promptKeys";
import { IS_MAC } from "../../lib/hotkey";

export type Place = { path: string; label: string };

/**
 * The session on screen, when it has not been written to: where it starts, the
 * worktrees it could start in, and what picking one does. Only that session's
 * first screen reads it; the chats behind other tabs are mounted too.
 */
export const PanePlaceContext = createContext<{ sessionId: string; place: Place; places: Place[]; onMove: (path: string) => void } | null>(null);

export const usePanePlace = (sessionId: string) => {
  const pick = useContext(PanePlaceContext);
  return pick?.sessionId === sessionId ? pick : null;
};

/** The pickers on screen, newest last: ⌥W in a first screen's composer opens the one it shows. */
const openers: (() => void)[] = [];

/** Whether the first screen on screen has worktrees to choose from. */
export const hasWorktreePicker = () => openers.length > 0;

/** Opens the worktree list of the first screen on screen. */
export function openWorktreePicker() {
  openers.at(-1)?.();
}

type KeyDown = KeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void };

/**
 * The worktree as a fact on a new session's first screen, opening the list of
 * worktrees it can start in: a search field, then the worktrees. ↑/↓ move,
 * Enter picks, Esc clears the search and then closes.
 */
export function WorktreeFact({ place, places, onMove }: { place: Place; places: Place[]; onMove: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** What had the keyboard when it opened: ⌥W from the composer goes back there, a click to the badge. */
  const back = useRef<HTMLElement | null>(null);
  const choosable = places.length > 1;

  const needle = query.trim();
  const rows = needle
    ? places
        .map((item, at) => ({ item, at, hit: fuzzyMatch(needle, item.label) }))
        .filter((row) => row.hit !== null)
        .sort((a, b) => b.hit!.score - a.hit!.score || a.at - b.at)
        .map((row) => row.item)
    : places;
  const active = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);
  const currentIndex = Math.max(0, places.findIndex((item) => item.path === place.path));

  const openChange = (next: boolean) => {
    if (next) {
      back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setCursor(currentIndex);
    }
    setOpen(next);
  };
  const latest = useRef(openChange);
  useEffect(() => {
    latest.current = openChange;
  });

  useEffect(() => {
    if (!choosable) return;
    const opener = () => latest.current(true);
    openers.push(opener);
    return () => {
      openers.splice(openers.indexOf(opener), 1);
    };
  }, [choosable]);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, needle]);

  if (!choosable)
    return (
      <span className="ds-fact" title="The only worktree">
        {mark()}
        <span>{place.label}</span>
      </span>
    );

  const pick = (item: Place) => {
    setOpen(false);
    if (item.path !== place.path) onMove(item.path);
  };

  const onKeyDown = (event: KeyDown) => {
    if (pickerKeyDown(event, "W", () => setOpen(false))) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      event.preventBaseUIHandler?.();
      setQuery("");
      setCursor(currentIndex);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor(Math.max(0, Math.min(rows.length - 1, (active < 0 ? 0 : active) + step)));
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={openChange} modal={false}>
      <Popover.Trigger className="ds-fact ds-fact-button" title={`Start this session in another worktree (${IS_MAC ? "⌥W" : "Alt+W"})`}>
        {mark()}
        <span>{place.label}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="center" sideOffset={6} className="z-50">
          <Popover.Popup
            initialFocus={search}
            finalFocus={() => back.current ?? true}
            onKeyDown={onKeyDown}
            className="flex max-h-[min(360px,70vh)] w-72 origin-(--transform-origin) flex-col overflow-hidden rounded-xl bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <SearchIcon className="size-3.5 shrink-0 text-icon" />
              <input
                ref={search}
                value={query}
                placeholder="Start this session in…"
                aria-label="Search worktrees"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(event.target.value.trim() ? 0 : currentIndex);
                }}
                className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-placeholder"
              />
            </div>
            <div ref={list} role="listbox" aria-label="Worktrees" className="min-h-0 flex-1 overflow-y-auto p-1">
              {rows.length === 0 ? (
                <p className="px-2 py-6 text-center text-placeholder">No matches</p>
              ) : (
                rows.map((item, index) => (
                  <div
                    key={item.path}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    data-highlighted={index === active ? "" : undefined}
                    onMouseMove={() => index !== active && setCursor(index)}
                    onClick={() => pick(item)}
                    className={ROW}
                  >
                    {mark()}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <CheckIcon className={`size-4 shrink-0 ${item.path === place.path ? "" : "invisible"}`} />
                  </div>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// The worktree icon the tab bar uses.
const mark = () => <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-icon" />;
