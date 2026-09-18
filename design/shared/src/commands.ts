/**
 * Every command the shell binds, with its default chord. Ids are shared with the
 * palette and the keybindings settings page.
 */
export type Chord = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
};

export type CommandDef = { label: string; keys: Chord; group: CommandGroup };

export type CommandGroup = "Tabs" | "Navigate" | "Create" | "Terminal" | "View" | "File";

const k = (key: string, extra: Omit<Chord, "key"> = {}): Chord => ({ key, ...extra });

export const COMMANDS = {
  "open-launcher": { label: "New Tab", keys: k("t", { mod: true }), group: "Tabs" },
  close: { label: "Close Tab", keys: k("w", { mod: true }), group: "Tabs" },
  "reopen-tab": { label: "Reopen Closed Tab", keys: k("t", { mod: true, shift: true }), group: "Tabs" },
  "next-tab": { label: "Next Tab", keys: k("]", { mod: true, shift: true }), group: "Tabs" },
  "prev-tab": { label: "Previous Tab", keys: k("[", { mod: true, shift: true }), group: "Tabs" },
  "tab-1": { label: "Go to Tab 1", keys: k("1", { mod: true }), group: "Tabs" },
  "tab-2": { label: "Go to Tab 2", keys: k("2", { mod: true }), group: "Tabs" },
  "tab-3": { label: "Go to Tab 3", keys: k("3", { mod: true }), group: "Tabs" },
  "tab-4": { label: "Go to Tab 4", keys: k("4", { mod: true }), group: "Tabs" },
  "tab-5": { label: "Go to Tab 5", keys: k("5", { mod: true }), group: "Tabs" },
  "tab-6": { label: "Go to Tab 6", keys: k("6", { mod: true }), group: "Tabs" },
  "tab-7": { label: "Go to Tab 7", keys: k("7", { mod: true }), group: "Tabs" },
  "tab-8": { label: "Go to Tab 8", keys: k("8", { mod: true }), group: "Tabs" },
  "last-tab": { label: "Go to Last Tab", keys: k("9", { mod: true }), group: "Tabs" },

  "open-palette": { label: "Command Palette", keys: k("k", { mod: true }), group: "Navigate" },
  "go-to-file": { label: "Go to File", keys: k("p", { mod: true }), group: "Navigate" },
  "open-actions": { label: "Show All Actions", keys: k("p", { mod: true, shift: true }), group: "Navigate" },
  "open-workspace": { label: "Open Workspace", keys: k("o", { mod: true }), group: "Navigate" },
  "switch-workspace": { label: "Switch Workspace", keys: k("o", { mod: true, shift: true }), group: "Navigate" },
  "next-workspace": { label: "Next Workspace", keys: k("]", { mod: true, ctrl: true }), group: "Navigate" },
  "prev-workspace": { label: "Previous Workspace", keys: k("[", { mod: true, ctrl: true }), group: "Navigate" },
  "workspace-1": { label: "Go to Workspace 1", keys: k("1", { mod: true, ctrl: true }), group: "Navigate" },
  "workspace-2": { label: "Go to Workspace 2", keys: k("2", { mod: true, ctrl: true }), group: "Navigate" },
  "workspace-3": { label: "Go to Workspace 3", keys: k("3", { mod: true, ctrl: true }), group: "Navigate" },

  "new-agent": { label: "New Agent", keys: k("n", { mod: true }), group: "Create" },
  "new-session": { label: "New Session", keys: k("n", { mod: true, shift: true }), group: "Create" },

  "find-in-terminal": { label: "Find in Terminal", keys: k("f", { mod: true }), group: "Terminal" },
  "zoom-in": { label: "Increase Terminal Font", keys: k("=", { mod: true }), group: "Terminal" },
  "zoom-out": { label: "Decrease Terminal Font", keys: k("-", { mod: true }), group: "Terminal" },
  "zoom-reset": { label: "Reset Terminal Font", keys: k("0", { mod: true }), group: "Terminal" },

  "toggle-sidebar": { label: "Toggle Sidebar", keys: k("b", { mod: true }), group: "View" },
  "toggle-theme": { label: "Toggle Light / Dark", keys: k("j", { mod: true, shift: true }), group: "View" },
  "open-routines": { label: "Routines", keys: k("r", { mod: true, shift: true }), group: "View" },
  "search-messages": { label: "Search Messages", keys: k("f", { mod: true, shift: true }), group: "View" },
  "open-settings": { label: "Settings", keys: k(",", { mod: true }), group: "View" },

  "save-file": { label: "Save File", keys: k("s", { mod: true }), group: "File" },
} as const satisfies Record<string, CommandDef>;

export type CommandId = keyof typeof COMMANDS;
export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

const GLYPH: Record<string, string> = {
  Enter: "⏎",
  Escape: "Esc",
  Backspace: "⌫",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Tab: "⇥",
};

/** "⌘⇧P" on macOS, "Ctrl+Shift+P" elsewhere. */
export function formatChord(chord: Chord): string {
  const key = GLYPH[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  if (IS_MAC) {
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
  }
  const parts = [chord.mod && "Ctrl", chord.ctrl && "Ctrl", chord.alt && "Alt", chord.shift && "Shift"]
    .filter(Boolean)
    .filter((part, i, all) => all.indexOf(part) === i);
  return [...parts, key].join("+");
}

export const commandKeys = (id: CommandId): string => formatChord(COMMANDS[id].keys);

/** Does this keyboard event fire that chord? Matches on `code` for punctuation. */
export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  if (Boolean(chord.mod) !== mod) return false;
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  // On macOS `ctrl` is a distinct modifier; elsewhere `mod` already is ctrl.
  if (IS_MAC && Boolean(chord.ctrl) !== event.ctrlKey) return false;
  if (event.key.toLowerCase() === chord.key.toLowerCase()) return true;
  // Shift+[ produces "{" on most layouts; fall back to the physical key.
  const code = event.code;
  if (chord.key === "[") return code === "BracketLeft";
  if (chord.key === "]") return code === "BracketRight";
  if (chord.key === "=") return code === "Equal";
  if (chord.key === "-") return code === "Minus";
  if (chord.key === ",") return code === "Comma";
  if (/^[0-9]$/.test(chord.key)) return code === `Digit${chord.key}`;
  return false;
}

/** Tab plumbing and the palette's own doors: bound, but noise in a command list. */
const UNLISTED =
  /^(tab-[1-8]|last-tab|next-tab|prev-tab|workspace-[1-9]|close|open-palette|go-to-file|open-actions)$/;

export function listedCommands(): Array<{ id: CommandId; label: string; keys: string }> {
  return COMMAND_IDS.filter((id) => !UNLISTED.test(id)).map((id) => ({
    id,
    label: COMMANDS[id].label,
    keys: commandKeys(id),
  }));
}
