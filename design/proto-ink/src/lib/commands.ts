import { useEffect } from "react";
import { COMMANDS, COMMAND_IDS, matchesChord } from "@crew/fixtures";
import type { CommandId } from "@crew/fixtures";
import { emit } from "./bus";
import { useApp, type Actions } from "./store";

/** Commands a surface owns; the shell must not swallow their chords. */
const SURFACE_OWNED = new Set<CommandId>(["find-in-terminal", "save-file"]);

export function runCommand(id: CommandId, actions: Actions, fontSize: number) {
  switch (id) {
    case "open-launcher":
      actions.setLauncher(true);
      return;
    case "close":
      actions.closeActiveTab();
      return;
    case "reopen-tab":
      actions.reopenTab();
      return;
    case "next-tab":
      actions.stepTab(1);
      return;
    case "prev-tab":
      actions.stepTab(-1);
      return;
    case "last-tab":
      actions.lastTab();
      return;
    case "open-palette":
      actions.openPalette("all");
      return;
    case "go-to-file":
      actions.openPalette("files");
      return;
    case "open-actions":
      actions.openPalette("actions");
      return;
    case "open-workspace":
      emit("workspace:open");
      return;
    case "switch-workspace":
      actions.setWorkspacePicker(true);
      return;
    case "next-workspace":
      actions.stepWorkspace(1);
      return;
    case "prev-workspace":
      actions.stepWorkspace(-1);
      return;
    case "new-agent":
      actions.openSheet(null);
      return;
    case "new-session":
      actions.createSession({
        name: `shell ${Math.floor(Math.random() * 90 + 10)}`,
        kind: "terminal",
        model: "",
      });
      return;
    case "find-in-terminal":
      emit("terminal:find");
      return;
    case "zoom-in":
      actions.setTerminal({ fontSize: Math.min(20, fontSize + 1) });
      return;
    case "zoom-out":
      actions.setTerminal({ fontSize: Math.max(10, fontSize - 1) });
      return;
    case "zoom-reset":
      actions.setTerminal({ fontSize: 12 });
      return;
    case "toggle-sidebar":
      actions.toggleSidebar();
      return;
    case "toggle-theme":
      actions.toggleTheme();
      return;
    case "open-routines":
      actions.openRoutines(null);
      return;
    case "search-messages":
      actions.openSearch();
      return;
    case "open-settings":
      actions.openSettings("general");
      return;
    case "save-file":
      emit("file:save");
      return;
    default: {
      const tab = /^tab-([1-8])$/.exec(id);
      if (tab) {
        actions.tabAt(Number(tab[1]) - 1);
        return;
      }
      const workspace = /^workspace-([1-9])$/.exec(id);
      if (workspace) actions.workspaceAt(Number(workspace[1]) - 1);
    }
  }
}

/** True when the event came from somewhere that owns its own keystrokes. */
function inTextField(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}

export function useGlobalCommands() {
  const { actions, terminal } = useApp();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      for (const id of COMMAND_IDS) {
        if (SURFACE_OWNED.has(id)) continue;
        if (!matchesChord(event, COMMANDS[id].keys)) continue;
        // A bare letter chord inside a text field belongs to the field, but every
        // command here carries a modifier, so the field never loses a keystroke.
        if (inTextField(event.target) && !COMMANDS[id].keys.mod) return;
        event.preventDefault();
        runCommand(id, actions, terminal.fontSize);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, terminal.fontSize]);
}
