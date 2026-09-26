import { COMMANDS, commandChords, type CommandId } from "./commands";

/**
 * The keybindings page's sections. A numbered run (⌘1‥9) is one row: nine rows
 * saying the same thing with a different digit is a list nobody reads.
 */
export type BindingRow = { id: string; label: string; chords: string[] };
export type BindingGroup = { title: string; rows: BindingRow[] };

type Entry = CommandId | { run: "workspace" | "worktree"; label: string };

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: "Tabs",
    entries: ["open-launcher", "close", "reopen-tab", "next-tab", "prev-tab"],
  },
  {
    title: "Workspaces and worktrees",
    entries: [
      "open-workspace",
      "switch-workspace",
      { run: "workspace", label: "Go to Workspace 1–9" },
      "next-workspace",
      "prev-workspace",
      "new-worktree",
      { run: "worktree", label: "Go to Worktree 1–9" },
      "next-worktree",
      "prev-worktree",
    ],
  },
  {
    title: "Agents and sessions",
    entries: ["new-agent", "new-session", "open-routines"],
  },
  {
    title: "Finding things",
    entries: ["open-palette", "go-to-file", "open-actions", "search-messages", "find"],
  },
  {
    title: "View",
    entries: ["toggle-sidebar", "focus-sidebar", "zoom-in", "zoom-out", "zoom-reset", "toggle-outline"],
  },
  {
    title: "Editor",
    entries: ["save-file"],
  },
  {
    title: "Browser",
    entries: [
      "browser-back",
      "browser-forward",
      "browser-focus-address",
      "browser-reload",
      "browser-hard-reload",
      "browser-devtools",
      "open-history",
      "open-browser-settings",
    ],
  },
  {
    title: "App",
    entries: ["open-settings", "shortcuts"],
  },
];

function rowOf(entry: Entry): BindingRow {
  if (typeof entry === "string") return { id: entry, label: COMMANDS[entry].label, chords: commandChords(entry) };
  const first = commandChords(`${entry.run}-1` as CommandId)[0] ?? "";
  const last = commandChords(`${entry.run}-9` as CommandId)[0] ?? "";
  return { id: `${entry.run}-n`, label: entry.label, chords: [`${first}–${last.slice(-1)}`] };
}

export function bindingGroups(): BindingGroup[] {
  return GROUPS.map((group) => ({ title: group.title, rows: group.entries.map(rowOf) }));
}

/** Every command a section lists, the numbered runs spelled out: what the test holds against COMMANDS. */
export function groupedCommandIds(): CommandId[] {
  return GROUPS.flatMap((group) =>
    group.entries.flatMap((entry) =>
      typeof entry === "string"
        ? [entry]
        : Array.from({ length: 9 }, (_, index) => `${entry.run}-${index + 1}` as CommandId),
    ),
  );
}
