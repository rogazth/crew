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
  "tab-1": { label: "Go to Tab 1", keys: "Mod+1" },
  "tab-2": { label: "Go to Tab 2", keys: "Mod+2" },
  "tab-3": { label: "Go to Tab 3", keys: "Mod+3" },
  "tab-4": { label: "Go to Tab 4", keys: "Mod+4" },
  "tab-5": { label: "Go to Tab 5", keys: "Mod+5" },
  "tab-6": { label: "Go to Tab 6", keys: "Mod+6" },
  "tab-7": { label: "Go to Tab 7", keys: "Mod+7" },
  "tab-8": { label: "Go to Tab 8", keys: "Mod+8" },
  "last-tab": { label: "Go to Last Tab", keys: "Mod+9" },

  // Finding things — three doors into one palette, each opening a different filter.
  "open-palette": { label: "Command Palette", keys: "Mod+K" },
  "go-to-file": { label: "Go to File", keys: "Mod+P" },
  "open-actions": { label: "Show All Actions", keys: "Mod+Shift+P" },
  "open-workspace": { label: "Open Workspace", keys: "Mod+O" },
  "switch-workspace": { label: "Switch Workspace", keys: "Mod+Shift+O" },
  // Workspaces sit one modifier above tabs: ⌃⌘ where tabs use ⌘, same keys.
  "next-workspace": { label: "Next Workspace", keys: { key: "]", mod: true, ctrl: true } },
  "prev-workspace": { label: "Previous Workspace", keys: { key: "[", mod: true, ctrl: true } },
  "workspace-1": { label: "Go to Workspace 1", keys: { key: "1", mod: true, ctrl: true } },
  "workspace-2": { label: "Go to Workspace 2", keys: { key: "2", mod: true, ctrl: true } },
  "workspace-3": { label: "Go to Workspace 3", keys: { key: "3", mod: true, ctrl: true } },
  "workspace-4": { label: "Go to Workspace 4", keys: { key: "4", mod: true, ctrl: true } },
  "workspace-5": { label: "Go to Workspace 5", keys: { key: "5", mod: true, ctrl: true } },
  "workspace-6": { label: "Go to Workspace 6", keys: { key: "6", mod: true, ctrl: true } },
  "workspace-7": { label: "Go to Workspace 7", keys: { key: "7", mod: true, ctrl: true } },
  "workspace-8": { label: "Go to Workspace 8", keys: { key: "8", mod: true, ctrl: true } },
  "workspace-9": { label: "Go to Workspace 9", keys: { key: "9", mod: true, ctrl: true } },

  // Making things
  "new-agent": { label: "New Agent", keys: "Mod+N" },
  "new-session": { label: "New Session", keys: "Mod+Shift+N" },

  // Terminal — bound only while a terminal fills the active tab.
  "find-in-terminal": { label: "Find in Terminal", keys: "Mod+F" },
  "zoom-in": { label: "Increase Terminal Font", keys: { key: "=", mod: true } },
  "zoom-out": { label: "Decrease Terminal Font", keys: { key: "-", mod: true } },
  "zoom-reset": { label: "Reset Terminal Font", keys: "Mod+0" },

  "toggle-sidebar": { label: "Toggle Sidebar", keys: "Mod+B" },
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
  /^(tab-[1-8]|last-tab|next-tab|prev-tab|workspace-[1-9]|close|open-palette|go-to-file|open-actions)$/;

/** Live commands worth offering in the palette, in declaration order. */
export function listedCommands(): { id: CommandId; label: string; keys: string }[] {
  return COMMAND_IDS.filter((id) => handlers.has(id) && !UNLISTED.test(id)).map((id) => ({
    id,
    label: COMMANDS[id].label,
    keys: commandKeys(id),
  }));
}
