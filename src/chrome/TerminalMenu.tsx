import { ActionMenu } from "./ActionMenu";
import type { MenuPoint } from "../lib/menu";
import { terminalActions } from "../lib/terminalMenu";

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
  const actions = terminalActions(hasSelection);

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
