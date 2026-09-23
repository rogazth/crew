import { IS_MAC } from "./hotkey";
import type { MenuAction } from "./menu";

/** The terminal's right-click menu. Copy needs a selection; Clear has no shortcut. */
export function terminalActions(hasSelection: boolean, mac = IS_MAC): MenuAction[] {
  const mod = mac ? "⌘" : "Ctrl+";
  return [
    { id: "copy", label: "Copy", icon: "copy", hotkey: `${mod}C`, disabled: !hasSelection },
    { id: "paste", label: "Paste", icon: "paste", hotkey: `${mod}V` },
    { id: "select-all", label: "Select All", icon: "select-all", hotkey: `${mod}A` },
    { id: "clear", label: "Clear", icon: "clear", hotkey: "" },
  ];
}
