import { formatBinding, matchesBinding } from "./hotkey";

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
  "next-tab": { label: "Next Tab", keys: "Mod+Shift+]" },
  "prev-tab": { label: "Previous Tab", keys: "Mod+Shift+[" },
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
  "find-in-sidebar": { label: "Find in Sidebar", keys: "Mod+Shift+F" },
  "open-workspace": { label: "Open Workspace", keys: "Mod+O" },

  // Making things
  "new-agent": { label: "New Agent", keys: "Mod+N" },
  "new-session": { label: "New Session", keys: "Mod+Shift+N" },

  "open-settings": { label: "Settings", keys: "Mod+," },
  "save-file": { label: "Save File", keys: "Mod+S" },
} as const;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

const handlers = new Map<CommandId, () => void>();

export function isCommandId(id: string): id is CommandId {
  return id in COMMANDS;
}

export function keysFor(id: CommandId): string {
  return COMMANDS[id].keys;
}

export function commandKeys(id: CommandId): string {
  return formatBinding(keysFor(id));
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
  /^(tab-[1-8]|last-tab|next-tab|prev-tab|close|open-palette|go-to-file|open-actions)$/;

/** Live commands worth offering in the palette, in declaration order. */
export function listedCommands(): { id: CommandId; label: string; keys: string }[] {
  return COMMAND_IDS.filter((id) => handlers.has(id) && !UNLISTED.test(id)).map((id) => ({
    id,
    label: COMMANDS[id].label,
    keys: commandKeys(id),
  }));
}

/** First bound command whose handler is registered. Unbound keys pass through. */
export function commandForEvent(event: KeyboardEvent): CommandId | null {
  for (const id of COMMAND_IDS) {
    if (!handlers.has(id)) continue;
    if (matchesBinding(event, keysFor(id))) return id;
  }
  return null;
}
