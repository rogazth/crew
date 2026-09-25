// PROTOTYPE — the proposed keymap. ⌃ stands in for ⌘ so the browser's reserved
// chords (⌘T ⌘W ⌘N ⌘1‥9) still reach the page.

export type Cmd =
  | "toggle-sidebar"
  | "palette"
  | "switch-context"
  | "go-to-file"
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "next-tab"
  | "prev-tab"
  | "next-workspace"
  | "prev-workspace"
  | `workspace-${number}`
  | "next-worktree"
  | "prev-worktree"
  | `worktree-${number}`
  | "new-agent"
  | "new-session"
  | "new-worktree"
  | "focus-sidebar"
  | "shortcuts"
  | "toggle-tab-mode";

export function match(e: KeyboardEvent): Cmd | null {
  const code = e.code;
  const alt = e.altKey;
  const shift = e.shiftKey;
  if (e.metaKey && e.ctrlKey && !alt && !shift) {
    if (code === "BracketRight") return "next-workspace";
    if (code === "BracketLeft") return "prev-workspace";
  }
  if (!(e.metaKey || e.ctrlKey)) return null;
  const digit = /^Digit([1-9])$/.exec(code)?.[1];

  if (alt && !shift) {
    if (digit) return `worktree-${Number(digit)}`;
    if (code === "BracketRight") return "next-worktree";
    if (code === "BracketLeft") return "prev-worktree";
    if (code === "KeyN") return "new-worktree";
    if (code === "KeyT") return "toggle-tab-mode";
    return null;
  }
  if (shift && !alt) {
    if (code === "BracketRight") return "next-tab";
    if (code === "BracketLeft") return "prev-tab";
    if (code === "KeyN") return "new-agent";
    if (code === "KeyO") return "switch-context";
    if (code === "KeyT") return "reopen-tab";
    if (code === "KeyE") return "focus-sidebar";
    return null;
  }
  if (!alt && !shift) {
    if (digit) return `workspace-${Number(digit)}`;
    if (code === "KeyB") return "toggle-sidebar";
    if (code === "KeyK") return "palette";
    if (code === "KeyP") return "go-to-file";
    if (code === "KeyT") return "new-tab";
    if (code === "KeyW") return "close-tab";
    if (code === "KeyN") return "new-session";
    if (code === "Slash") return "shortcuts";
  }
  return null;
}

export const KEYS: Record<string, string> = {
  "toggle-sidebar": "⌘B",
  palette: "⌘K",
  "switch-context": "⇧⌘O",
  "go-to-file": "⌘P",
  "new-tab": "⌘T",
  "close-tab": "⌘W",
  "reopen-tab": "⇧⌘T",
  "next-tab": "⇧⌘]",
  "prev-tab": "⇧⌘[",
  "next-workspace": "⌃⌘]",
  "prev-workspace": "⌃⌘[",
  "next-worktree": "⌥⌘]",
  "prev-worktree": "⌥⌘[",
  "new-agent": "⇧⌘N",
  "new-session": "⌘N",
  "new-worktree": "⌥⌘N",
  "focus-sidebar": "⇧⌘E",
  shortcuts: "⌘/",
  "toggle-tab-mode": "⌥⌘T",
};

export function keysOf(cmd: Cmd): string {
  const ws = /^workspace-(\d)$/.exec(cmd)?.[1];
  if (ws) return `⌘${ws}`;
  const tree = /^worktree-(\d)$/.exec(cmd)?.[1];
  if (tree) return `⌥⌘${tree}`;
  return KEYS[cmd] ?? "";
}

export const LABELS: Record<string, string> = {
  "toggle-sidebar": "Toggle Sidebar",
  palette: "Command Palette",
  "switch-context": "Switch Workspace / Worktree",
  "go-to-file": "Go to File",
  "new-tab": "New Tab",
  "close-tab": "Close Tab",
  "reopen-tab": "Reopen Closed Tab",
  "next-tab": "Next Tab",
  "prev-tab": "Previous Tab",
  "next-workspace": "Next Workspace",
  "prev-workspace": "Previous Workspace",
  "next-worktree": "Next Worktree",
  "prev-worktree": "Previous Worktree",
  "new-agent": "New Agent",
  "new-session": "New Session",
  "new-worktree": "New Worktree",
  "focus-sidebar": "Focus Sidebar",
  shortcuts: "Keyboard Shortcuts",
  "toggle-tab-mode": "Toggle Tabs: per Worktree / All",
};

export function labelOf(cmd: Cmd): string {
  const ws = /^workspace-(\d)$/.exec(cmd)?.[1];
  if (ws) return `Go to Workspace ${ws}`;
  const tree = /^worktree-(\d)$/.exec(cmd)?.[1];
  if (tree) return `Go to Worktree ${tree}`;
  return LABELS[cmd] ?? cmd;
}

export const CHEATSHEET: { group: string; rows: [string, string][] }[] = [
  {
    group: "Context",
    rows: [
      ["⌘1‥9", "Go to workspace"],
      ["⌃⌘[  ⌃⌘]", "Previous / next workspace"],
      ["⌥⌘1‥9", "Go to worktree (in this workspace)"],
      ["⌥⌘[  ⌥⌘]", "Previous / next worktree"],
      ["⇧⌘O", "Switch to any repo › worktree"],
    ],
  },
  {
    group: "Create",
    rows: [
      ["⌘N", "New session (terminal) in this worktree"],
      ["⇧⌘N", "New agent — pick worktree or new branch"],
      ["⌥⌘N", "New worktree"],
    ],
  },
  {
    group: "Tabs",
    rows: [
      ["⌘T  ⌘P", "Open file in this worktree"],
      ["⌘W  ⇧⌘T", "Close / reopen tab"],
      ["⇧⌘[  ⇧⌘]", "Previous / next tab"],
      ["⌥⌘T", "Prototype: tabs per worktree ⇄ all"],
    ],
  },
  {
    group: "Sidebar",
    rows: [
      ["⌘B", "Toggle sidebar"],
      ["⇧⌘E", "Focus sidebar"],
      ["↑ ↓ ← →", "Move (spatial, works in the agent grid)"],
      ["← →  on a group", "Collapse / expand"],
      ["↵", "Open"],
      ["F2", "Rename"],
      ["⌘⌫", "Delete session / remove worktree"],
      ["/", "Filter the list"],
      ["Esc", "Back to the tab"],
    ],
  },
  {
    group: "Everywhere",
    rows: [
      ["⌘K", "Command palette"],
      ["⌘/", "This sheet"],
      ["⌃⌥←  ⌃⌥→", "Prototype: previous / next variant"],
    ],
  },
];
