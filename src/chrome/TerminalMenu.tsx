import { ActionMenu } from "./ActionMenu";
import type { MenuAction, MenuPoint } from "../lib/menu";
import { IS_MAC } from "../lib/hotkey";

const MOD = IS_MAC ? "⌘" : "Ctrl+";

type Props = {
  point: MenuPoint;
  hasSelection: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onClose: () => void;
};

export function TerminalMenu({
  point,
  hasSelection,
  onCopy,
  onPaste,
  onSelectAll,
  onClear,
  onClose,
}: Props) {
  const actions: MenuAction[] = [
    { id: "copy", label: "Copy", icon: "copy", hotkey: `${MOD}C`, disabled: !hasSelection },
    { id: "paste", label: "Paste", icon: "paste", hotkey: `${MOD}V` },
    { id: "select-all", label: "Select All", icon: "select-all", hotkey: `${MOD}A` },
    { id: "clear", label: "Clear", icon: "clear", hotkey: "" },
  ];

  const run: Record<string, () => void> = {
    copy: onCopy,
    paste: onPaste,
    "select-all": onSelectAll,
    clear: onClear,
  };

  return (
    <ActionMenu
      point={point}
      actions={actions}
      onPick={(id) => {
        run[id]?.();
        onClose();
      }}
      onClose={onClose}
    />
  );
}
