import { commandKeys } from "./commands";
import { IS_MAC, isDeleteChord } from "./hotkey";
import { DELETE, EDIT, RENAME, type MenuAction } from "./menu";
import type { ClickModifiers } from "./selection";
import type { SessionGroup } from "./sidebarPrefs";
import type { Session } from "./types";

/** ⌘ (Ctrl off macOS) toggles a row into the selection; Shift extends it. */
export function clickModifiers(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  mac = IS_MAC,
): ClickModifiers {
  return { toggle: mac ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

/** Only a group that holds one kind knows what its plus would create. */
export function groupAdd(group: SessionGroup): { command: "new-agent" | "new-session"; hint: string } | null {
  if (group.kind === "agent") return { command: "new-agent", hint: `New agent ${commandKeys("new-agent")}` };
  if (group.kind === "terminal") return { command: "new-session", hint: `New session ${commandKeys("new-session")}` };
  return null;
}

/** A row inside a multi-selection acts for the whole selection; any other row acts alone. */
export function actsOnSelection(session: Session, selected: Set<string>): boolean {
  return selected.size > 1 && selected.has(session.id);
}

/** The right-click menu: one delete for a multi-selection, else edit (agent) or rename (terminal), then delete. */
export function rowMenuActions(session: Session, selected: Set<string>): MenuAction[] {
  if (actsOnSelection(session, selected)) return [{ ...DELETE, label: `Delete ${selected.size} items` }];
  return session.kind === "agent" ? [EDIT, DELETE] : [RENAME, DELETE];
}

export type RowKey = "rename" | "clear" | "remove";

/** F2 renames a row that can be renamed, Escape drops the selection, the delete chord removes. */
export function rowKeyAction(event: { key: string; metaKey: boolean }, canRename: boolean): RowKey | null {
  if (event.key === "F2" && canRename) return "rename";
  if (event.key === "Escape") return "clear";
  if (isDeleteChord(event)) return "remove";
  return null;
}
