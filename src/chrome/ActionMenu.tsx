import {
  BroomIcon,
  ClipboardIcon,
  CopyIcon,
  PencilSimpleIcon,
  SelectionAllIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { IS_MAC, isDeleteChord } from "../lib/hotkey";

export type MenuAction = {
  id: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Single key that fires the action while the menu is open; shown as the shortcut. */
  hotkey: string;
  danger?: boolean;
  disabled?: boolean;
};

export type MenuPoint = { x: number; y: number };

export const RENAME: MenuAction = { id: "rename", label: "Rename", icon: "edit", hotkey: "R" };
export const EDIT: MenuAction = { id: "edit", label: "Edit", icon: "edit", hotkey: "E" };
export const DELETE: MenuAction = {
  id: "delete",
  label: "Delete",
  icon: "delete",
  hotkey: IS_MAC ? "⌘⌫" : "Del",
  danger: true,
};

const ICONS = {
  edit: PencilSimpleIcon,
  delete: TrashIcon,
  copy: CopyIcon,
  paste: ClipboardIcon,
  clear: BroomIcon,
  "select-all": SelectionAllIcon,
};

type Props = {
  point: MenuPoint;
  actions: MenuAction[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** When set, the name field sits at the top of the popover and focuses on open. */
  rename?: { initial: string; onCommit: (name: string) => void };
};

function keyOf(action: MenuAction): string {
  return action.hotkey.toLowerCase();
}

export function menuFromEvent(event: MouseEvent): MenuPoint {
  event.preventDefault();
  event.stopPropagation();
  return { x: event.clientX, y: event.clientY };
}

/**
 * Right-click popover at the cursor.
 * Optional `rename` is an autofocused field in the popover, not a row replacement.
 */
export function ActionMenu({ point, actions, onPick, onClose, rename }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const skipCommit = useRef(false);
  const [name, setName] = useState(rename?.initial ?? "");

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
      return;
    }
    const hit = isDeleteChord(event)
      ? actions.find((action) => action.id === "delete")
      : actions.find((action) => keyOf(action) === event.key.toLowerCase());
    if (!hit || hit.disabled) return;
    event.preventDefault();
    onPick(hit.id);
  }

  return createPortal(
    <div
      ref={surface}
      role="menu"
      tabIndex={-1}
      aria-label="Actions"
      onKeyDown={onMenuKey}
      onContextMenu={(event) => event.preventDefault()}
      className={`fixed z-50 rounded-lg bg-kumo-control p-1.5 text-kumo-default shadow-lg ring ring-kumo-line outline-none ${
        rename ? "w-56" : "w-max"
      }`}
      style={{ left: point.x, top: point.y }}
    >
      {rename && (
        <input
          ref={input}
          autoFocus
          value={name}
          aria-label="Rename"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (!skipCommit.current) commitRename();
          }}
          className="mb-1.5 w-full rounded-md bg-kumo-fill px-2.5 py-1.5 text-[13px] font-medium text-kumo-default caret-kumo-default outline-none ring-1 ring-kumo-interact"
        />
      )}
      {actions.map((action) => {
        const Icon = ICONS[action.icon];
        const tone = action.danger
          ? "text-kumo-danger hover:bg-kumo-danger/10"
          : "text-kumo-default hover:bg-hover";
        return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            disabled={action.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(action.id)}
            className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
              action.disabled ? "text-kumo-placeholder" : tone
            }`}
          >
            <Icon className="size-4 shrink-0" />
            <span>{action.label}</span>
            <span className="ml-auto pl-6 text-[11px] text-kumo-subtle">{action.hotkey}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
