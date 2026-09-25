import { formatForDisplay, type RegisterableHotkey } from "@tanstack/react-hotkeys";
import type { LiveCommand } from "./keymap";

type Command = { label: string; keys?: RegisterableHotkey; repeat?: boolean };

/**
 * App commands. The id is what handlers, menus, and settings share.
 * `keys` is the default binding; user overrides land here later. A command
 * without one is reached only from the palette and its buttons.
 * A command only fires while something has registered a handler — that is the when.
 * `repeat` lets a held chord keep firing; everything else fires once per press.
 */
export const COMMANDS = {
  // Tabs — browser conventions, so the muscle memory transfers.
  "open-launcher": { label: "New Tab", keys: "Mod+T" },
  close: { label: "Close Tab", keys: "Mod+W" },
  "reopen-tab": { label: "Reopen Closed Tab", keys: "Mod+Shift+T" },
  // TanStack's `Hotkey` string type excludes Shift+punctuation, so these two take the
  // object form. Matching still falls back to event.code, which is what puts tab
  // cycling on the same physical keys the browser uses on every layout.
  "next-tab": { label: "Next Tab", keys: { key: "]", mod: true, shift: true }, repeat: true },
  "prev-tab": { label: "Previous Tab", keys: { key: "[", mod: true, shift: true }, repeat: true },

  // Finding things — three doors into one palette, each opening a different filter.
  "open-palette": { label: "Command Palette", keys: "Mod+K" },
  "go-to-file": { label: "Go to File", keys: "Mod+P" },
  "open-actions": { label: "Show All Actions", keys: "Mod+Shift+P" },
  "open-workspace": { label: "Open Workspace", keys: "Mod+O" },
  "switch-workspace": { label: "Switch Workspace", keys: "Mod+Shift+O" },
  // The digits belong to workspaces; the tab strip keeps only the cycling pair.
  // ⌃⌘ spelled out, not Mod+Ctrl: off macOS that collapses to Ctrl alone, which is Back and Forward.
  "next-workspace": { label: "Next Workspace", keys: { key: "]", ctrl: true, meta: true } },
  "prev-workspace": { label: "Previous Workspace", keys: { key: "[", ctrl: true, meta: true } },
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

  // Find and zoom — bound by whatever fills the active tab, a terminal or a page.
  find: { label: "Find", keys: "Mod+F" },
  "zoom-in": { label: "Zoom In", keys: { key: "=", mod: true } },
  "zoom-out": { label: "Zoom Out", keys: { key: "-", mod: true } },
  "zoom-reset": { label: "Actual Size", keys: "Mod+0" },

  // Browser — bound only while a page fills the active tab. History is always there.
  "browser-back": { label: "Back", keys: { key: "[", mod: true } },
  "browser-forward": { label: "Forward", keys: { key: "]", mod: true } },
  "browser-focus-address": { label: "Focus Address Bar", keys: "Mod+L" },
  "browser-reload": { label: "Reload Page", keys: "Mod+R" },
  "browser-hard-reload": { label: "Hard Reload Page", keys: "Mod+Shift+R" },
  "browser-devtools": { label: "Toggle Developer Tools", keys: "Mod+Alt+I" },
  "open-history": { label: "History", keys: "Mod+Y" },

  "toggle-sidebar": { label: "Toggle Sidebar", keys: "Mod+B" },
  // ⌘⇧R is the page's hard reload; Routines is one click away in the sidebar.
  "open-routines": { label: "Routines" },
  "search-messages": { label: "Search Messages", keys: "Mod+Shift+F" },
  "open-settings": { label: "Settings", keys: "Mod+," },
  "save-file": { label: "Save File", keys: "Mod+S" },
} as const satisfies Record<string, Command>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

const handlers = new Map<CommandId, () => void>();
const listeners = new Set<() => void>();
let flushing = false;
let published = "";

export function isCommandId(id: string): id is CommandId {
  return id in COMMANDS;
}

export function keysFor(id: CommandId): RegisterableHotkey | undefined {
  const command: Command = COMMANDS[id];
  return command.keys;
}

/** The binding as the platform spells it, or "" for a command with none. */
export function commandKeys(id: CommandId): string {
  const keys = keysFor(id);
  return keys ? formatForDisplay(keys) : "";
}

export function repeatable(id: CommandId): boolean {
  const command: Command = COMMANDS[id];
  return command.repeat === true;
}

export function registerCommand(id: CommandId, handler: () => void): () => void {
  // Swapping the handler of a live id leaves the set as it was.
  if (!handlers.has(id)) changed();
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) !== handler) return;
    handlers.delete(id);
    changed();
  };
}

export function runCommand(id: CommandId): boolean {
  const handler = handlers.get(id);
  if (!handler) return false;
  handler();
  return true;
}

/**
 * Tells `cb` the set of live commands changed, at most once per microtask: a
 * render that unbinds and rebinds a dozen commands costs the main process one
 * update, and none if the set came out the same.
 */
export function onCommandsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function changed(): void {
  if (flushing) return;
  flushing = true;
  queueMicrotask(() => {
    flushing = false;
    const live = COMMAND_IDS.filter((id) => handlers.has(id)).join(" ");
    if (live === published) return;
    published = live;
    for (const listener of listeners) listener();
  });
}

/** Commands with a handler and a binding right now, in declaration order: what a focused page forwards. */
export function liveCommands(): LiveCommand[] {
  return COMMAND_IDS.flatMap((id) => {
    const keys = keysFor(id);
    return handlers.has(id) && keys ? [{ id, keys, repeat: repeatable(id) }] : [];
  });
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
