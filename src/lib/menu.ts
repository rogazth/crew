import type { MouseEvent } from "react";
import { IS_MAC } from "./hotkey";

export type MenuIcon =
  | "edit"
  | "delete"
  | "copy"
  | "paste"
  | "clear"
  | "select-all"
  | "close"
  | "open"
  | "face"
  | "bell"
  | "read"
  | "agent"
  | "terminal"
  | "branch"
  | "reopen"
  | "settings"
  | "play"
  | "stop"
  | "pause";

export type MenuAction = {
  id: string;
  label: string;
  icon: MenuIcon;
  /** Single key that fires the action while the menu is open; shown as the shortcut. */
  hotkey: string;
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

export const RENAME: MenuAction = { id: "rename", label: "Rename", icon: "edit", hotkey: "R" };
export const EDIT: MenuAction = { id: "edit", label: "Agent Settings…", icon: "settings", hotkey: "E" };
export const DELETE: MenuAction = {
  id: "delete",
  label: "Delete",
  icon: "delete",
  hotkey: IS_MAC ? "⌘⌫" : "Del",
  danger: true,
};

export const OPEN: MenuAction = { id: "open", label: "Open", icon: "open", hotkey: "O" };
export const COPY_PATH: MenuAction = { id: "copy-path", label: "Copy Path", icon: "copy", hotkey: "C" };
export const COPY_URL: MenuAction = { id: "copy-url", label: "Copy URL", icon: "copy", hotkey: "C" };
export const CLOSE_TAB: MenuAction = { id: "close", label: "Close Tab", icon: "close", hotkey: "W" };
export const CLOSE_OTHERS: MenuAction = { id: "close-others", label: "Close Other Tabs", icon: "close", hotkey: "O" };
export const CLOSE_RIGHT: MenuAction = { id: "close-right", label: "Close Tabs to the Right", icon: "close", hotkey: "R" };
export const REOPEN_TAB: MenuAction = { id: "reopen", label: "Reopen Closed Tab", icon: "reopen", hotkey: "T" };
export const CHANGE_FACE: MenuAction = { id: "face", label: "Change Face…", icon: "face", hotkey: "F" };
export const COPY_NAME: MenuAction = { id: "copy-name", label: "Copy Name", icon: "copy", hotkey: "C" };
export const MARK_READ: MenuAction = { id: "mark-read", label: "Mark as Read", icon: "read", hotkey: "M" };

export function menuFromEvent(event: MouseEvent): MenuPoint {
  event.preventDefault();
  event.stopPropagation();
  return { x: event.clientX, y: event.clientY };
}
