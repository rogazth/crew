import type { MouseEvent } from "react";

export type MenuIcon =
  | "edit"
  | "delete"
  | "copy"
  | "paste"
  | "clear"
  | "select-all"
  | "close"
  | "open"
  | "bell"
  | "read"
  | "bot"
  | "terminal"
  | "branch"
  | "reopen"
  | "settings"
  | "pin"
  | "unpin"
  | "collapse"
  | "expand"
  | "play"
  | "stop"
  | "row-above"
  | "row-below"
  | "column-left"
  | "column-right"
  | "duplicate"
  | "move-up"
  | "move-down"
  | "move-left"
  | "move-right"
  | "sort-asc"
  | "sort-desc"
  | "align-left"
  | "align-center"
  | "align-right"
  | "code";

export type MenuAction = {
  id: string;
  label: string;
  icon: MenuIcon;
  danger?: boolean;
  disabled?: boolean;
  /** A setting the action flips: drawn with a check when on. */
  checked?: boolean;
};

/** A hairline between groups of actions. */
export const SEPARATOR = "separator" as const;
export type MenuEntry = MenuAction | typeof SEPARATOR;

/** Separators only where both sides have actions: a menu built from conditions never starts, ends or doubles one. */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry === SEPARATOR && (out.length === 0 || out[out.length - 1] === SEPARATOR)) continue;
    out.push(entry);
  }
  if (out[out.length - 1] === SEPARATOR) out.pop();
  return out;
}

export type MenuPoint = { x: number; y: number };

export const RENAME: MenuAction = { id: "rename", label: "Rename", icon: "edit" };
export const EDIT: MenuAction = { id: "edit", label: "Bot settings…", icon: "settings" };
export const DELETE: MenuAction = {
  id: "delete",
  label: "Delete",
  icon: "delete",
  danger: true,
};

export const OPEN: MenuAction = { id: "open", label: "Open", icon: "open" };
export const COPY_PATH: MenuAction = { id: "copy-path", label: "Copy path", icon: "copy" };
export const COPY_URL: MenuAction = { id: "copy-url", label: "Copy URL", icon: "copy" };
export const CLOSE_TAB: MenuAction = { id: "close", label: "Close tab", icon: "close" };
export const CLOSE_OTHERS: MenuAction = { id: "close-others", label: "Close other tabs", icon: "close" };
export const CLOSE_RIGHT: MenuAction = { id: "close-right", label: "Close tabs to the right", icon: "close" };
export const REOPEN_TAB: MenuAction = { id: "reopen", label: "Reopen closed tab", icon: "reopen" };
export const PIN_TAB: MenuAction = { id: "pin", label: "Pin tab", icon: "pin" };
export const UNPIN_TAB: MenuAction = { id: "unpin", label: "Unpin tab", icon: "unpin" };
export const COLLAPSE_WORKTREE: MenuAction = { id: "collapse", label: "Collapse worktree tabs", icon: "collapse" };
export const COLLAPSE_OTHERS: MenuAction = { id: "collapse-others", label: "Collapse other worktrees", icon: "collapse" };
export const EXPAND_WORKTREE: MenuAction = { id: "expand", label: "Expand tabs", icon: "expand" };
export const CLOSE_WORKTREE: MenuAction = { id: "close-group", label: "Close worktree tabs", icon: "close" };
export const COPY_NAME: MenuAction = { id: "copy-name", label: "Copy name", icon: "copy" };
export const MARK_READ: MenuAction = { id: "mark-read", label: "Mark as read", icon: "read" };

export function menuFromEvent(event: MouseEvent): MenuPoint {
  event.preventDefault();
  event.stopPropagation();
  return { x: event.clientX, y: event.clientY };
}
