import { formatForDisplay, type RegisterableHotkey } from "@tanstack/react-hotkeys";

/**
 * App commands. The id is what handlers, menus, and settings share.
 * `keys` is the default binding; user overrides land here later.
 * A command only fires while something has registered a handler — that is the when.
 */
export const COMMANDS = {
  // Tabs — browser conventions, so the muscle memory transfers.
  "open-launcher": { label: "New Tab", keys: "Mod+T" },
  close: { label: "Close Tab", keys: "Mod+W" },
  "reopen-tab": { label: "Reopen Closed Tab", keys: "Mod+Shift+T" },
  // TanStack's `Hotkey` string type excludes Shift+punctuation, so these two take the
  // object form. Matching still falls back to event.code, which is what puts tab
  // cycling on the same physical keys the browser uses on every layout.
  "next-tab": { label: "Next Tab", keys: { key: "]", mod: true, shift: true } },
  "prev-tab": { label: "Previous Tab", keys: { key: "[", mod: true, shift: true } },

  // Finding things — three doors into one palette, each opening a different filter.
  "open-palette": { label: "Command Palette", keys: "Mod+K" },
  "go-to-file": { label: "Go to File", keys: "Mod+P" },
  "open-actions": { label: "Show All Actions", keys: "Mod+Shift+P" },
  "open-workspace": { label: "Open Workspace", keys: "Mod+O" },
  "switch-workspace": { label: "Switch Workspace", keys: "Mod+Shift+O" },
  // The digits belong to workspaces; the tab strip keeps only the cycling pair.
  "next-workspace": { label: "Next Workspace", keys: { key: "]", mod: true, ctrl: true } },
  "prev-workspace": { label: "Previous Workspace", keys: { key: "[", mod: true, ctrl: true } },
  "workspace-1": { label: "Go to Workspace 1", keys: "Mod+1" },
  "workspace-2": { label: "Go to Workspace 2", keys: "Mod+2" },
  "workspace-3": { label: "Go to Workspace 3", keys: "Mod+3" },
  "workspace-4": { label: "Go to Workspace 4", keys: "Mod+4" },
  "workspace-5": { label: "Go to Workspace 5", keys: "Mod+5" },
  "workspace-6": { label: "Go to Workspace 6", keys: "Mod+6" },
  "workspace-7": { label: "Go to Workspace 7", keys: "Mod+7" },
  "workspace-8": { label: "Go to Workspace 8", keys: "Mod+8" },
  "workspace-9": { label: "Go to Workspace 9", keys: "Mod+9" },

  // Making things
  "new-agent": { label: "New Agent", keys: "Mod+Shift+N" },
  "new-session": { label: "New Session", keys: "Mod+N" },

  // Terminal — bound only while a terminal fills the active tab.
  "find-in-terminal": { label: "Find in Terminal", keys: "Mod+F" },
  "zoom-in": { label: "Increase Terminal Font", keys: { key: "=", mod: true } },
  "zoom-out": { label: "Decrease Terminal Font", keys: { key: "-", mod: true } },
  "zoom-reset": { label: "Reset Terminal Font", keys: "Mod+0" },

  "toggle-sidebar": { label: "Toggle Sidebar", keys: "Mod+B" },
  "open-routines": { label: "Routines", keys: "Mod+Shift+R" },
  "search-messages": { label: "Search Messages", keys: "Mod+Shift+F" },
  "open-settings": { label: "Settings", keys: "Mod+," },
  "save-file": { label: "Save File", keys: "Mod+S" },
} as const satisfies Record<string, { label: string; keys: RegisterableHotkey }>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

const handlers = new Map<CommandId, () => void>();

export function isCommandId(id: string): id is CommandId {
  return id in COMMANDS;
}

export function keysFor(id: CommandId): RegisterableHotkey {
  return COMMANDS[id].keys;
}

export function commandKeys(id: CommandId): string {
  return formatForDisplay(keysFor(id));
}

export function registerCommand(id: CommandId, handler: () => void): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

export function runCommand(id: CommandId): boolean {
  const handler = handlers.get(id);
  if (!handler) return false;
  handler();
  return true;
}

/** Tab plumbing and the palette's own doors: bound, but noise in a command list. */
const UNLISTED =
  /^(next-tab|prev-tab|workspace-[1-9]|close|open-palette|go-to-file|open-actions)$/;

/** Live commands worth offering in the palette, in declaration order. */
export function listedCommands(): { id: CommandId; label: string; keys: string }[] {
  return COMMAND_IDS.flatMap((id) =>
    handlers.has(id) && !UNLISTED.test(id)
      ? [{ id, label: COMMANDS[id].label, keys: commandKeys(id) }]
      : [],
  );
}
