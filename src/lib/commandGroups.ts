import { COMMANDS, commandChords, defaultChords, type CommandId } from "./commands";
import { IS_MAC } from "./hotkey";

/**
 * The commands in sections, for the keybindings page and the shortcuts sheet (⌘/), so the two
 * read as one map. A numbered run (⌘1‥9) is one row: nine rows saying the same thing with a
 * different digit is a list nobody reads.
 */
export type BindingRow = {
  id: string;
  label: string;
  /** What runs the command now. */
  chords: string[];
  /** What it ships with. */
  defaults: string[];
  /** A numbered run follows one pattern; it is shown, not edited. */
  fixed: boolean;
};
export type BindingGroup = { title: string; rows: BindingRow[] };

/**
 * `ids` with `sheet`: commands the page lists one by one and the sheet as one row under `sheet`,
 * as long as each of them has a chord. A lone id there only renames it in the sheet.
 */
type Entry = CommandId | { ids: CommandId[]; sheet: string } | { run: "workspace"; label: string };

/** A section, for whatever marks it beside its title. */
export type Section =
  | "tabs"
  | "workspaces"
  | "bots"
  | "services"
  | "finding"
  | "view"
  | "app"
  | "sidebar"
  | "prompt"
  | "editor"
  | "browser";

/** `focused` marks a section whose chords work only with the focus in what it names: the sheet puts it beside the others. */
const GROUPS: { id: Section; title: string; focused?: true; entries: Entry[] }[] = [
  {
    id: "tabs",
    title: "Tabs",
    entries: [
      "open-launcher",
      { ids: ["new-browser-tab", "new-incognito-tab"], sheet: "New browser / incognito tab" },
      { ids: ["close", "reopen-tab"], sheet: "Close / reopen tab" },
      { ids: ["prev-tab", "next-tab"], sheet: "Previous / next tab" },
    ],
  },
  {
    id: "workspaces",
    title: "Workspaces and worktrees",
    entries: [
      "open-workspace",
      "switch-workspace",
      "go-home",
      { run: "workspace", label: "Go to Workspace 1–9" },
      { ids: ["prev-workspace", "next-workspace"], sheet: "Previous / next workspace" },
      "new-worktree",
    ],
  },
  {
    id: "bots",
    title: "Bots and sessions",
    entries: ["new-bot", "new-session", "open-routines"],
  },
  {
    id: "services",
    title: "Services",
    entries: ["open-commands", "start-all-commands", "stop-all-commands"],
  },
  {
    id: "finding",
    title: "Finding things",
    entries: [
      { ids: ["open-palette"], sheet: "Find chats, files, workspaces and commands" },
      "go-to-file",
      "open-actions",
      "search-files",
      "find",
    ],
  },
  {
    id: "view",
    title: "View",
    entries: [
      "toggle-sidebar",
      "toggle-explorer",
      { ids: ["zoom-in", "zoom-out", "zoom-reset"], sheet: "Zoom in / out / actual size" },
      "toggle-outline",
    ],
  },
  {
    id: "app",
    title: "App",
    entries: ["open-settings", "shortcuts"],
  },
  {
    id: "editor",
    title: "Editor",
    focused: true,
    entries: ["save-file", "toggle-reading", "insert-table"],
  },
  {
    id: "browser",
    title: "Browser",
    focused: true,
    entries: [
      { ids: ["browser-back", "browser-forward"], sheet: "Back / forward" },
      "browser-focus-address",
      { ids: ["browser-reload", "browser-hard-reload"], sheet: "Reload / hard reload" },
      "browser-devtools",
      "open-history",
      "open-browser-settings",
    ],
  },
];

function commandRow(id: CommandId): BindingRow {
  return { id, label: COMMANDS[id].label, chords: commandChords(id), defaults: defaultChords(id), fixed: false };
}

function runRow(entry: { run: "workspace"; label: string }): BindingRow {
  const first = commandChords(`${entry.run}-1` as CommandId)[0] ?? "";
  const last = commandChords(`${entry.run}-9` as CommandId)[0] ?? "";
  const chords = [`${first}–${last.slice(-1)}`];
  return { id: `${entry.run}-n`, label: entry.label, chords, defaults: chords, fixed: true };
}

function rowsOf(entry: Entry): BindingRow[] {
  if (typeof entry === "string") return [commandRow(entry)];
  if ("run" in entry) return [runRow(entry)];
  return entry.ids.map(commandRow);
}

export function bindingGroups(): BindingGroup[] {
  return GROUPS.map((group) => ({ title: group.title, rows: group.entries.flatMap(rowsOf) }));
}

/** Every command a section lists, the numbered runs spelled out: what the test holds against COMMANDS. */
export function groupedCommandIds(): CommandId[] {
  return GROUPS.flatMap((group) =>
    group.entries.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if ("ids" in entry) return entry.ids;
      return Array.from({ length: 9 }, (_, index) => `${entry.run}-${index + 1}` as CommandId);
    }),
  );
}

/* ── The shortcuts sheet ────────────────────────────────────────────── */

/** One line of the sheet: what it does, and a keycap per chord. */
export type SheetRow = { label: string; keys: string[] };
export type SheetGroup = { id: Section; title: string; rows: SheetRow[] };
export type SheetColumn = SheetGroup[];

/**
 * Keys the sidebar and the prompt read themselves: not commands, so they cannot be rebound.
 * The arrows and ↵ do what anyone would try first, and are left out.
 */
const FIXED: SheetGroup[] = [
  {
    id: "sidebar",
    title: "Sidebar",
    rows: [
      { label: "Rename", keys: ["F2"] },
      { label: "Actions menu", keys: ["⇧F10"] },
      { label: "Delete session or worktree", keys: [IS_MAC ? "⌘⌫" : "Delete"] },
      { label: "Find", keys: ["/"] },
    ],
  },
  {
    id: "prompt",
    title: "Prompt",
    rows: [
      { label: "Choose model", keys: [IS_MAC ? "⌥P" : "Alt+P"] },
      { label: "Choose worktree", keys: [IS_MAC ? "⌥W" : "Alt+W"] },
      { label: "Step effort", keys: ["⇧Tab"] },
    ],
  },
];

/**
 * A command's line in the sheet, from the live bindings: the one chord it shows first, or nothing
 * for a command without one. A set whose chords are all there is one line; one missing a chord
 * leaves the others on lines of their own.
 */
function sheetRows(entry: Entry): SheetRow[] {
  if (typeof entry === "string") return lineOf(entry);
  if ("run" in entry) {
    // The run shows as a range only while both ends still have their chord.
    const ends = [1, 9].map((n) => commandChords(`${entry.run}-${n}` as CommandId)[0]);
    return ends.every(Boolean) ? [{ label: "Go to workspace", keys: runRow(entry).chords }] : [];
  }
  const keys = entry.ids.flatMap((id) => commandChords(id).slice(0, 1));
  if (keys.length === entry.ids.length) return [{ label: entry.sheet, keys }];
  return entry.ids.flatMap(lineOf);
}

function lineOf(id: CommandId): SheetRow[] {
  const chord = commandChords(id)[0];
  return chord ? [{ label: COMMANDS[id].label, keys: [chord] }] : [];
}

/** What the sheet shows: what works anywhere on one side, what works with the focus somewhere on the other. */
export function sheetColumns(): SheetColumn[] {
  const groups = (focused: boolean) =>
    GROUPS.filter((group) => Boolean(group.focused) === focused)
      .map((group) => ({ id: group.id, title: group.title, rows: group.entries.flatMap(sheetRows) }))
      .filter((group) => group.rows.length > 0);
  return [groups(false), [...FIXED, ...groups(true)]].filter((column) => column.length > 0);
}
