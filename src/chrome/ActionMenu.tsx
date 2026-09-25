import { BellIcon, BotIcon, BrushCleaningIcon, CheckCheckIcon, CheckIcon, ClipboardIcon, CopyIcon, ExternalLinkIcon, GitBranchIcon, PencilIcon, RotateCcwIcon, SettingsIcon, SquareDashedMousePointerIcon, SquareTerminalIcon, Trash2Icon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { isDeleteChord } from "../lib/hotkey";
import { SEPARATOR, type MenuAction, type MenuEntry, type MenuIcon, type MenuPoint } from "../lib/menu";

const ICONS: Record<MenuIcon, Icon> = {
  edit: PencilIcon,
  delete: Trash2Icon,
  copy: CopyIcon,
  paste: ClipboardIcon,
  clear: BrushCleaningIcon,
  "select-all": SquareDashedMousePointerIcon,
  close: XIcon,
  open: ExternalLinkIcon,
  bell: BellIcon,
  read: CheckCheckIcon,
  agent: BotIcon,
  terminal: SquareTerminalIcon,
  branch: GitBranchIcon,
  reopen: RotateCcwIcon,
  settings: SettingsIcon,
};

type Props = {
  point: MenuPoint;
  actions: MenuEntry[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** Said above the actions: whose menu this is, when a right-click leaves any doubt. */
  title?: string;
  /** When set, the name field sits at the top of the popover and focuses on open. */
  rename?: { initial: string; onCommit: (name: string) => void };
};

function keyOf(action: MenuAction): string {
  return action.hotkey.toLowerCase();
}

/**
 * Right-click popover at the cursor, in the same frame as every other menu.
 * ↑↓ walk the actions, ↵ runs one, and each action's letter runs it directly.
 * Optional `rename` is an autofocused field in the popover, not a row replacement.
 */
export function ActionMenu({ point, actions, onPick, onClose, title, rename }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const skipCommit = useRef(false);
  const [name, setName] = useState(rename?.initial ?? "");
  const runnable = actions.filter((entry): entry is MenuAction => entry !== SEPARATOR && !entry.disabled);
  const [cursor, setCursor] = useState(-1);

  useLayoutEffect(() => {
    const el = surface.current;
    if (!el || !point) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    let left = point.x;
    let top = point.y;
    if (left + rect.width > innerWidth - 8) left = Math.max(8, innerWidth - rect.width - 8);
    if (top + rect.height > innerHeight - 8) top = Math.max(8, point.y - rect.height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [point]);

  useEffect(() => {
    if (rename) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    } else {
      surface.current?.focus();
    }
  }, [rename]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (surface.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      skipCommit.current = true;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  function commitRename() {
    const next = name.trim();
    if (rename && next && next !== rename.initial) rename.onCommit(next);
  }

  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target === input.current) {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
        onClose();
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor(0);
        surface.current?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (c + step + runnable.length) % runnable.length);
      return;
    }
    if (event.key === "Enter") {
      const hit = runnable[cursor];
      if (!hit) return;
      event.preventDefault();
      onPick(hit.id);
      return;
    }
    const hit = isDeleteChord(event)
      ? runnable.find((action) => action.id.includes("delete") || action.id.includes("remove"))
      : runnable.find((action) => keyOf(action) === event.key.toLowerCase());
    if (!hit) return;
    event.preventDefault();
    onPick(hit.id);
  }

  return createPortal(
    <div
      ref={surface}
      role="menu"
      tabIndex={-1}
      aria-label={title ?? "Actions"}
      onKeyDown={onMenuKey}
      onContextMenu={(event) => event.preventDefault()}
      className={`fixed z-50 min-w-52 rounded-xl bg-surface p-1 text-text shadow-float outline-none ${
        rename ? "w-60" : "w-max"
      }`}
      style={{ left: point.x, top: point.y }}
    >
      {title && <div className="truncate px-2 pt-1.5 pb-1 text-[11px] text-text-muted">{title}</div>}
      {rename && (
        <input
          ref={input}
          autoFocus
          value={name}
          aria-label="Rename"
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (!skipCommit.current) commitRename();
          }}
          className="mb-1 h-8 w-full rounded-md bg-canvas px-2.5 font-medium text-text ring ring-border outline-none focus:ring-[1.5px] focus:ring-focus/50"
        />
      )}
      {actions.map((entry, index) => {
        if (entry === SEPARATOR) return <div key={`separator-${index}`} role="separator" className="mx-2 my-1 h-px bg-border" />;
        const Glyph = ICONS[entry.icon];
        const lit = runnable[cursor]?.id === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setCursor(runnable.indexOf(entry))}
            onClick={() => onPick(entry.id)}
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${
              entry.disabled
                ? "text-placeholder"
                : entry.danger
                  ? `text-danger ${lit ? "bg-danger/10" : ""}`
                  : lit
                    ? "bg-hover"
                    : ""
            }`}
          >
            <Glyph className={`size-4 shrink-0 ${entry.danger || entry.disabled ? "" : "text-icon"}`} />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.checked && <CheckIcon className="size-3.5 shrink-0" />}
            {entry.hotkey && <span className="shrink-0 pl-4 text-[11px] text-text-muted">{entry.hotkey}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
