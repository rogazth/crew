import type { CommandId } from "./commands";
import { isDeleteChord } from "./hotkey";

/** Past this many the list stops fitting in one glance and earns a search field. */
export const SEARCHABLE_FROM = 8;

export function isSearchable(count: number): boolean {
  return count >= SEARCHABLE_FROM;
}

/** ⌃⌘1‥9 jump straight to a row; the hint on the row teaches the chord. */
export function jumpCommand(index: number): CommandId | null {
  return index < 9 ? (`workspace-${index + 1}` as CommandId) : null;
}

/**
 * The row a bare digit picks, 0-based, while the list and not a search holds
 * focus. A digit with ⌘ or Ctrl belongs to the app's own jump chords.
 */
export function digitRow(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  filtering: boolean,
): number | null {
  if (filtering || event.metaKey || event.ctrlKey || !/^[1-9]$/.test(event.key)) return null;
  return Number(event.key) - 1;
}

/** F2 opens a row's rename menu; the delete chord removes the row. */
export function workspaceRowKey(event: { key: string; metaKey: boolean }): "rename" | "remove" | null {
  if (event.key === "F2") return "rename";
  if (isDeleteChord(event)) return "remove";
  return null;
}
