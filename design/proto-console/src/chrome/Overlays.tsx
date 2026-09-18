import { AgentSheet } from "./AgentSheet";
import { CommandPalette } from "./CommandPalette";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShortcutSheet } from "./ShortcutSheet";
import { TabLauncher } from "./TabLauncher";

export function Overlays() {
  return (
    <>
      <CommandPalette />
      <TabLauncher />
      <AgentSheet />
      <ConfirmDialog />
      <ShortcutSheet />
    </>
  );
}
