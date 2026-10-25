import { ActionMenu } from "./ActionMenu";
import type { MenuAction, MenuPoint } from "../lib/menu";

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
    { id: "copy", label: "Copy", icon: "copy", disabled: !hasSelection },
    { id: "paste", label: "Paste", icon: "paste" },
    { id: "select-all", label: "Select all", icon: "select-all" },
    { id: "clear", label: "Clear", icon: "clear" },
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
