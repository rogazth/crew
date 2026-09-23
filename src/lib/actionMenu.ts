import { isDeleteChord } from "./hotkey";
import type { MenuAction, MenuPoint } from "./menu";

const EDGE = 8;

type Size = { width: number; height: number };

/**
 * Where a popover opened at `point` sits so it stays on screen: pushed left off
 * the right edge, and flipped above the cursor off the bottom one.
 */
export function placeMenu(point: MenuPoint, menu: Size, viewport: Size): { left: number; top: number } {
  let left = point.x;
  let top = point.y;
  if (left + menu.width > viewport.width - EDGE) left = Math.max(EDGE, viewport.width - menu.width - EDGE);
  if (top + menu.height > viewport.height - EDGE) top = Math.max(EDGE, point.y - menu.height);
  return { left, top };
}

/** The action a key fires while the menu has focus: the delete chord, or a row's single-key hotkey. */
export function actionForKey(actions: MenuAction[], event: { key: string; metaKey: boolean }): MenuAction | null {
  const hit = isDeleteChord(event)
    ? actions.find((action) => action.id === "delete")
    : actions.find((action) => action.hotkey.toLowerCase() === event.key.toLowerCase());
  return hit && !hit.disabled ? hit : null;
}
