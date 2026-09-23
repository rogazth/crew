import type { MouseEvent } from "react";
import { IS_MAC } from "./hotkey";

export type MenuIcon = "edit" | "delete" | "copy" | "paste" | "clear" | "select-all";

export type MenuAction = {
  id: string;
  label: string;
  icon: MenuIcon;
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

export function menuFromEvent(event: MouseEvent): MenuPoint {
  event.preventDefault();
  event.stopPropagation();
  return { x: event.clientX, y: event.clientY };
}
