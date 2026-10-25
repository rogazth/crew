import { formatForDisplay, type RegisterableHotkey } from "@tanstack/react-hotkeys";
import { parseChord, toHotkey } from "./chords";
import { IS_MAC } from "./hotkey";
import type { LiveCommand } from "./keymap";

/**
 * `also` are further chords for the same command, for keys that sit elsewhere on other layouts.
 * `offMac` replaces `keys` and `also` off macOS, where the platform's own chord for it is another.
 */
type Command = {
  label: string;
  keys?: RegisterableHotkey;
  also?: RegisterableHotkey[];
  offMac?: RegisterableHotkey;
  repeat?: boolean;
};

/**
 * App commands. The id is what handlers, menus, and settings share.
 * `keys` is the default binding; the user's overrides replace it (see setKeyOverrides). A command
 * without one is reached only from the palette and its buttons.
 * A command only fires while something has registered a handler — that is the when.
 * `repeat` lets a held chord keep firing; everything else fires once per press.
 */
export const COMMANDS = {
  // Tabs — browser conventions, so the muscle memory transfers.
  "open-launcher": { label: "New tab", keys: "Mod+T" },
  close: { label: "Close tab", keys: "Mod+W" },
  "reopen-tab": { label: "Reopen closed tab", keys: "Mod+Shift+T" },
  // TanStack's `Hotkey` string type excludes Shift+punctuation, so these two take the
  // object form. A brace is its bracket (see keymap), so ⇧⌘} is the same chord on a
  // US board, where } is ⇧], and a Latin American one, where ] is ⇧}.
  "next-tab": { label: "Next tab", keys: { key: "]", mod: true, shift: true }, repeat: true },
  "prev-tab": { label: "Previous tab", keys: { key: "[", mod: true, shift: true }, repeat: true },

  // Finding things — three doors into one palette, each opening a different filter.
  "open-palette": { label: "Command palette", keys: "Mod+K" },
  "go-to-file": { label: "Go to file", keys: "Mod+P" },
  "open-actions": { label: "Show all actions", keys: "Mod+Shift+P" },
  "open-workspace": { label: "Open workspace", keys: "Mod+O" },
  "switch-workspace": { label: "Switch workspace", keys: "Mod+Shift+O" },
  // The digits belong to workspaces; the tab strip keeps only the cycling pair.
  // Each level up the ladder takes a harder chord: tabs ⌘⇧, workspaces ⌘⌥.
  "go-home": { label: "Go home", keys: "Mod+Shift+H" },
  "next-workspace": { label: "Next workspace", keys: { key: "]", mod: true, alt: true } },
  "prev-workspace": { label: "Previous workspace", keys: { key: "[", mod: true, alt: true } },
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
  "new-bot": { label: "New bot", keys: "Mod+Shift+A" },
  "new-session": { label: "New session", keys: "Mod+N" },
  "new-worktree": { label: "New worktree", keys: { key: "N", ctrl: true, meta: true } },
  // ⇧⌘N is Chrome's incognito window, so the muscle memory transfers; B is for browser.
  "new-browser-tab": { label: "New browser tab", keys: "Mod+Shift+B" },
  "new-incognito-tab": { label: "New incognito tab", keys: "Mod+Shift+N" },

  // Find and zoom — bound by whatever fills the active tab: a terminal or a page zooms
  // itself, anything else zooms the window.
  find: { label: "Find", keys: "Mod+F" },
  // ⌘+ is what the key says on most layouts; ⌘= is the same key unshifted on a US one.
  "zoom-in": { label: "Zoom in", keys: { key: "+", mod: true }, also: [{ key: "=", mod: true }, { key: "+", mod: true, shift: true }] },
  "zoom-out": { label: "Zoom out", keys: { key: "-", mod: true } },
  "zoom-reset": { label: "Actual size", keys: "Mod+0" },

  // Browser — bound only while a page fills the active tab. History is always there.
  "browser-back": { label: "Back", keys: { key: "[", mod: true } },
  "browser-forward": { label: "Forward", keys: { key: "]", mod: true } },
  "browser-focus-address": { label: "Focus address bar", keys: "Mod+L" },
  "browser-reload": { label: "Reload page", keys: "Mod+R" },
  "browser-hard-reload": { label: "Hard reload page", keys: "Mod+Shift+R" },
  // Chrome's chords off macOS: Ctrl+Y is Redo there, and Ctrl+Alt+I is no one's DevTools.
  "browser-devtools": { label: "Toggle developer tools", keys: "Mod+Alt+I", offMac: "Mod+Shift+I" },
  "open-history": { label: "History", keys: "Mod+Y", offMac: "Mod+H" },

  "toggle-sidebar": { label: "Toggle sidebar", keys: "Mod+B" },
  // VS Code's chords: the explorer beside the tabs, and search in the workspace's files.
  "toggle-explorer": { label: "Toggle explorer", keys: "Mod+Shift+E" },
  "search-files": { label: "Search in files", keys: "Mod+Shift+F" },
  // ⌘⇧R is the page's hard reload; Routines is one click away in the sidebar.
  "open-routines": { label: "Routines" },
  // The workspace's dev servers and watchers, run per worktree.
  "open-commands": { label: "Commands" },
  "start-all-commands": { label: "Start all commands" },
  "stop-all-commands": { label: "Stop all commands" },
  "open-settings": { label: "Settings", keys: "Mod+," },
  "open-browser-settings": { label: "Browser settings" },
  "save-file": { label: "Save file", keys: "Mod+S" },
  "toggle-outline": { label: "Toggle outline" },
  // A note opens to read; the same chord turns it to editing and back.
  "toggle-reading": { label: "Toggle reading view", keys: "Mod+E" },
  "insert-table": { label: "Insert table" },
  // ⇧⌘/ too: where / is a shifted key (⇧7 on a Latin American board) ⌘/ cannot be typed,
  // and on a US board it is ⌘?, the Help chord.
  shortcuts: { label: "Keyboard shortcuts", keys: { key: "/", mod: true }, also: [{ key: "/", mod: true, shift: true }] },
} as const satisfies Record<string, Command>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

const handlers = new Map<CommandId, () => void>();
const listeners = new Set<() => void>();
let flushing = false;
let published = "|{}";

export function isCommandId(id: string): id is CommandId {
  return id in COMMANDS;
}

/**
 * What the user changed: a stored chord ("Mod+Shift+K") in place of the default
 * binding, or null for a command left without one. An override replaces every
 * default chord of the command, `also` included.
 */
export type KeyOverrides = Readonly<Record<string, string | null>>;

let overrides: KeyOverrides = {};
let resolved = new Map<string, RegisterableHotkey[]>();
const overrideListeners = new Set<() => void>();

export function keyOverrides(): KeyOverrides {
  return overrides;
}

/** Binds the commands as `next` says, in the window's dispatcher and (through the live list) in main. */
export function setKeyOverrides(next: KeyOverrides): void {
  overrides = next;
  resolved = new Map();
  for (const [id, chord] of Object.entries(next)) {
    if (!isCommandId(id)) continue;
    const parsed = chord === null ? null : parseChord(chord);
    if (chord === null) resolved.set(id, []);
    else if (parsed) resolved.set(id, [toHotkey(parsed) as RegisterableHotkey]);
  }
  changed();
  for (const listener of overrideListeners) listener();
}

export function onKeyOverridesChange(cb: () => void): () => void {
  overrideListeners.add(cb);
  return () => {
    overrideListeners.delete(cb);
  };
}

/** The chords the command ships with on the platform, whatever the user changed. */
export function defaultKeysFor(id: CommandId, isMac = IS_MAC): RegisterableHotkey[] {
  const command: Command = COMMANDS[id];
  if (!isMac && command.offMac) return [command.offMac];
  return command.keys ? [command.keys, ...(command.also ?? [])] : [];
}

export function keysFor(id: CommandId): RegisterableHotkey | undefined {
  return allKeysFor(id)[0];
}

/** Every chord that runs the command: the one shown first, then the others. */
export function allKeysFor(id: CommandId): RegisterableHotkey[] {
  return resolved.get(id) ?? defaultKeysFor(id);
}

/** macOS writes modifiers in one order, ⌃⌥⇧⌘, run together with the key. */
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** The binding as the platform spells it, or "" for a command with none. */
export function commandKeys(id: CommandId): string {
  const keys = keysFor(id);
  return keys ? chordLabel(keys) : "";
}

/** Every chord of the command as the platform spells it, the one shown first. */
export function commandChords(id: CommandId): string[] {
  return allKeysFor(id).map(chordLabel);
}

/** Every chord the command ships with, as the platform spells it. */
export function defaultChords(id: CommandId): string[] {
  return defaultKeysFor(id).map(chordLabel);
}

/** A stored chord as the platform spells it; the text itself when it is not one. */
export function storedChordLabel(chord: string): string {
  const parsed = parseChord(chord);
  return parsed ? chordLabel(toHotkey(parsed) as RegisterableHotkey) : chord;
}

function chordLabel(keys: RegisterableHotkey): string {
  const shown = formatForDisplay(keys).replace("^", "⌃");
  if (!MAC_ORDER.some((glyph) => shown.includes(glyph))) return shown;
  const parts = shown.split(/\s+/).join("");
  const mods = MAC_ORDER.filter((glyph) => parts.includes(glyph)).join("");
  const key = [...parts].filter((glyph) => !MAC_ORDER.includes(glyph)).join("");
  // The formatter writes a "+" key as nothing at all, leaving ⌘ for ⌘+.
  return mods + (key || "+");
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
    const live = `${COMMAND_IDS.filter((id) => handlers.has(id)).join(" ")}|${JSON.stringify(overrides)}`;
    if (live === published) return;
    published = live;
    for (const listener of listeners) listener();
  });
}

/** Commands with a handler and a binding right now, in declaration order: what a focused page forwards. */
export function liveCommands(): LiveCommand[] {
  return COMMAND_IDS.flatMap((id) =>
    handlers.has(id) ? allKeysFor(id).map((keys) => ({ id, keys, repeat: repeatable(id) })) : [],
  );
}

/** Tab plumbing and the palette's own doors: bound, but noise in a command list. */
const UNLISTED =
  /^(next-tab|prev-tab|workspace-[1-9]|worktree-[1-9]|close|open-palette|go-to-file|open-actions)$/;

/** Live commands worth offering in the palette, in declaration order. */
export function listedCommands(): { id: CommandId; label: string; keys: string }[] {
  return COMMAND_IDS.flatMap((id) =>
    handlers.has(id) && !UNLISTED.test(id)
      ? [{ id, label: COMMANDS[id].label, keys: commandKeys(id) }]
      : [],
  );
}
