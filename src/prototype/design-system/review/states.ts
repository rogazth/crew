// PROTOTYPE — throwaway. Every state the redesign has to be reviewed in, as a
// place in the seeded design profile (`npm run app:design`): the picker walks
// the real app there instead of anyone running a turn, a shell or a command by
// hand. Names are the seed's (scripts/seed.mjs); a state whose workspace or
// session is not in the profile says so instead of guessing.
import type { SettingsSectionId } from "../../../lib/settings";
import type { UpdatePhase } from "../direction";

/** A workspace by name; a remote one also by its machine. */
export type WorkspaceRef = "home" | { name: string; machine?: string };

export type Target =
  | { kind: "workspace"; ws: WorkspaceRef; tree?: string }
  | { kind: "session"; ws: WorkspaceRef; name: string }
  | { kind: "new-session"; ws: WorkspaceRef }
  | { kind: "shell"; ws: WorkspaceRef; tree?: string; run: string }
  | { kind: "commands"; ws: WorkspaceRef }
  | { kind: "process"; ws: WorkspaceRef; name: string }
  | { kind: "file"; ws: WorkspaceRef; relative: string }
  | { kind: "browser"; ws: WorkspaceRef; url: string }
  | { kind: "history"; ws: WorkspaceRef }
  | { kind: "explorer"; ws: WorkspaceRef; mode: "files" | "search" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "add-machine" }
  | { kind: "routines"; ws?: WorkspaceRef; bot?: string }
  | { kind: "sheet"; ws: WorkspaceRef; name?: string }
  | { kind: "palette"; ws: WorkspaceRef; mode: "all" | "files" | "actions" | "context" }
  | { kind: "dialog"; ws: WorkspaceRef; dialog: "new-worktree" | "shortcuts" }
  | { kind: "machines"; ws: WorkspaceRef }
  | { kind: "confirm"; ws: WorkspaceRef; name: string }
  | { kind: "update"; phase: UpdatePhase };

export type ReviewState = { id: string; group: string; label: string; hint: string; target: Target };

const crew = { name: "crew" };
const spendo = { name: "spendo" };
const orca = { name: "orca" };
const devbox = { name: "api", machine: "devbox" };

const RAW: Omit<ReviewState, "id">[] = [
  // ── Workspaces ─────────────────────────────────────────────
  { group: "Workspaces", label: "Busy workspace", hint: "crew › main: bots as faces in every status, sessions below, a running command", target: { kind: "workspace", ws: crew, tree: "main" } },
  { group: "Workspaces", label: "Worktree with work in it", hint: "crew › feat/tab-indicators: its own bots, its own tab strip, +/− on the line", target: { kind: "workspace", ws: crew, tree: "feat/tab-indicators" } },
  { group: "Workspaces", label: "Empty worktree", hint: "crew › exp/voxel-avatars-…: nobody in it, a long branch name", target: { kind: "workspace", ws: crew, tree: "exp/voxel-avatars-without-background-and-rounded-corners" } },
  { group: "Workspaces", label: "Many bots", hint: "orca: the face grid wraps, folded worktrees stack their faces", target: { kind: "workspace", ws: orca, tree: "main" } },
  { group: "Workspaces", label: "Sessions at volume", hint: "spendo: sessions of the user's, subagents, letters between sessions", target: { kind: "workspace", ws: spendo, tree: "main" } },
  { group: "Workspaces", label: "One bot, nothing else", hint: "landing", target: { kind: "workspace", ws: { name: "landing" } } },
  { group: "Workspaces", label: "Empty folder, no git", hint: "notes: no worktrees, no bots, no sessions", target: { kind: "workspace", ws: { name: "notes" } } },
  { group: "Workspaces", label: "Home", hint: "The start page: ask, open a folder, make a bot", target: { kind: "workspace", ws: "home" } },
  { group: "Workspaces", label: "Remote machine, online", hint: "devbox › api: a second crewd, its bots and its banner", target: { kind: "workspace", ws: devbox } },
  { group: "Workspaces", label: "Remote machine, offline", hint: "gpu-box › training: nobody answers, the banner says why", target: { kind: "workspace", ws: { name: "training", machine: "gpu-box" } } },

  // ── Bots ───────────────────────────────────────────────────
  { group: "Bots", label: "Every block the chat draws", hint: "Showcase: todos, tools, diffs, code, tables, mermaid, math, images, usage", target: { kind: "session", ws: crew, name: "Showcase" } },
  { group: "Bots", label: "Working, waits for an approval", hint: "Planner: an Edit to allow or deny, the working line, the context meter", target: { kind: "session", ws: crew, name: "Planner" } },
  { group: "Bots", label: "Asks a question", hint: "Reviewer: a question card with options", target: { kind: "session", ws: crew, name: "Reviewer" } },
  { group: "Bots", label: "Done, after a letter from a bot", hint: "Scribe: a message from Planner in the thread, a reply sent back", target: { kind: "session", ws: crew, name: "Scribe" } },
  { group: "Bots", label: "Turn failed", hint: "Tester: a failing command and the CLI's exit", target: { kind: "session", ws: crew, name: "Tester" } },
  { group: "Bots", label: "New bot, nothing said yet", hint: "Archivist: the empty chat's intro", target: { kind: "session", ws: crew, name: "Archivist" } },
  { group: "Bots", label: "Working in a worktree", hint: "Indicator: a command still running", target: { kind: "session", ws: crew, name: "Indicator" } },
  { group: "Bots", label: "Bots writing to each other", hint: "Atlas: letters out and in, queued and steered", target: { kind: "session", ws: orca, name: "Atlas" } },
  { group: "Bots", label: "Paused after 20 automatic turns", hint: "Comet: letters keep landing, the composer says it is paused", target: { kind: "session", ws: orca, name: "Comet" } },
  { group: "Bots", label: "Remote bot, working", hint: "Deployer on devbox: a command following logs", target: { kind: "session", ws: devbox, name: "Deployer" } },
  { group: "Bots", label: "Remote bot, approval", hint: "Migrator on devbox: run psql?", target: { kind: "session", ws: devbox, name: "Migrator" } },

  // ── Subagents ──────────────────────────────────────────────
  { group: "Subagents", label: "Lead with a subagent in every state", hint: "Conductor: five subagents, one per provider, background work", target: { kind: "session", ws: crew, name: "Conductor" } },
  { group: "Subagents", label: "Subagent thread: report in", hint: "Scout, inside Conductor's tab", target: { kind: "session", ws: crew, name: "Scout" } },
  { group: "Subagents", label: "Subagent thread: working", hint: "Flake hunter (codex)", target: { kind: "session", ws: crew, name: "Flake hunter" } },
  { group: "Subagents", label: "Subagent thread: asks", hint: "Release notes (opencode): its question shows in the parent too", target: { kind: "session", ws: crew, name: "Release notes" } },
  { group: "Subagents", label: "Subagent thread: failed", hint: "Linux port (cursor)", target: { kind: "session", ws: crew, name: "Linux port" } },
  { group: "Subagents", label: "Subagent thread: exited", hint: "Bundle spike, an edit interrupted", target: { kind: "session", ws: crew, name: "Bundle spike" } },
  { group: "Subagents", label: "Eight subagents, one nested two deep", hint: "Ledger rewrite: orchestration at volume, a dozen jobs running", target: { kind: "session", ws: spendo, name: "Ledger rewrite" } },
  { group: "Subagents", label: "Nested subagent thread", hint: "OFX parser, a subagent of Importer", target: { kind: "session", ws: spendo, name: "OFX parser" } },

  // ── Sessions ───────────────────────────────────────────────
  { group: "Sessions", label: "Session that delegated and left shells", hint: "Payments migration: two subagents working, background jobs", target: { kind: "session", ws: crew, name: "Payments migration" } },
  { group: "Sessions", label: "Session, step by step with the user", hint: "Release checklist", target: { kind: "session", ws: crew, name: "Release checklist" } },
  { group: "Sessions", label: "Sessions writing to each other", hint: "Recurring API, writing to Recurring UI next door", target: { kind: "session", ws: spendo, name: "Recurring API" } },
  { group: "Sessions", label: "Session waiting on another", hint: "Recurring UI: needs input", target: { kind: "session", ws: spendo, name: "Recurring UI" } },
  { group: "Sessions", label: "Launched for the user", hint: "Review ledger PR, handed off by Ledger rewrite", target: { kind: "session", ws: spendo, name: "Review ledger PR" } },
  { group: "Sessions", label: "Session done", hint: "QA pass", target: { kind: "session", ws: spendo, name: "QA pass" } },
  { group: "Sessions", label: "New session, nothing said yet", hint: "The empty chat's intro; it goes away with its tab, as a blank session does", target: { kind: "new-session", ws: crew } },

  // ── Shells ─────────────────────────────────────────────────
  { group: "Shells", label: "Shell with output", hint: "crew › main: git log, git status and a listing, typed for you", target: { kind: "shell", ws: crew, run: "git --no-pager log --oneline --graph --decorate -12 && git status --short --branch && ls -la" } },
  { group: "Shells", label: "Shell in a worktree", hint: "crew › feat/tab-indicators: its diff stat", target: { kind: "shell", ws: crew, tree: "feat/tab-indicators", run: "git status && git --no-pager diff --stat" } },
  { group: "Shells", label: "Shell with colour and a failure", hint: "A command that fails, then one that prints colour", target: { kind: "shell", ws: crew, run: "ls --nope; printf '\\e[32m✓ passed\\e[0m  \\e[31m✗ failed\\e[0m  \\e[33m! warned\\e[0m\\n'" } },

  // ── Commands ───────────────────────────────────────────────
  { group: "Commands", label: "Commands panel", hint: "crew: running, crash-looping, failed, stopped, never run, waiting for approval", target: { kind: "commands", ws: crew } },
  { group: "Commands", label: "Command running", hint: "Web: a dev server's live log", target: { kind: "process", ws: crew, name: "Web" } },
  { group: "Commands", label: "Command crash-looping", hint: "Worker: restarts until it gives up", target: { kind: "process", ws: crew, name: "Worker" } },
  { group: "Commands", label: "Command exited 1", hint: "Migrate", target: { kind: "process", ws: crew, name: "Migrate" } },
  { group: "Commands", label: "Command stopped", hint: "Storybook, started and stopped", target: { kind: "process", ws: crew, name: "Storybook" } },
  { group: "Commands", label: "No commands yet", hint: "spendo: the empty panel", target: { kind: "commands", ws: spendo } },

  // ── Tabs ───────────────────────────────────────────────────
  { group: "Tabs", label: "File", hint: "README.md in the editor", target: { kind: "file", ws: crew, relative: "README.md" } },
  { group: "Tabs", label: "Page", hint: "A browser tab", target: { kind: "browser", ws: crew, url: "https://example.com" } },
  { group: "Tabs", label: "History", hint: "The browser's history", target: { kind: "history", ws: crew } },
  { group: "Tabs", label: "File explorer", hint: "The tree beside the chat", target: { kind: "explorer", ws: crew, mode: "files" } },
  { group: "Tabs", label: "Search in files", hint: "The explorer's search", target: { kind: "explorer", ws: crew, mode: "search" } },

  // ── Dialogs ────────────────────────────────────────────────
  { group: "Dialogs", label: "Edit a bot", hint: "Planner's sheet", target: { kind: "sheet", ws: crew, name: "Planner" } },
  { group: "Dialogs", label: "New bot", hint: "The sheet, empty", target: { kind: "sheet", ws: crew } },
  { group: "Dialogs", label: "Command palette", hint: "⌘K", target: { kind: "palette", ws: crew, mode: "all" } },
  { group: "Dialogs", label: "Go to file", hint: "⌘P", target: { kind: "palette", ws: crew, mode: "files" } },
  { group: "Dialogs", label: "Switch workspace or worktree", hint: "The context switcher", target: { kind: "palette", ws: crew, mode: "context" } },
  { group: "Dialogs", label: "Open a workspace on a machine", hint: "The machine picker", target: { kind: "machines", ws: crew } },
  { group: "Dialogs", label: "New worktree", hint: "Branch name and an optional bot", target: { kind: "dialog", ws: crew, dialog: "new-worktree" } },
  { group: "Dialogs", label: "Keyboard shortcuts", hint: "Every binding", target: { kind: "dialog", ws: crew, dialog: "shortcuts" } },
  { group: "Dialogs", label: "Confirm a delete", hint: "Delete bot \"Archivist\"?", target: { kind: "confirm", ws: crew, name: "Archivist" } },

  // ── Pages ──────────────────────────────────────────────────
  { group: "Pages", label: "Routines", hint: "Daily, interval, cron and a disabled one, with run history", target: { kind: "routines" } },
  { group: "Pages", label: "New routine", hint: "The bot picker, every workspace's bots", target: { kind: "routines", ws: crew, bot: "Planner" } },
  { group: "Pages", label: "Settings › General", hint: "", target: { kind: "settings", section: "general" } },
  { group: "Pages", label: "Settings › Appearance", hint: "Theme and style", target: { kind: "settings", section: "appearance" } },
  { group: "Pages", label: "Settings › Notifications", hint: "", target: { kind: "settings", section: "notifications" } },
  { group: "Pages", label: "Settings › Terminal", hint: "", target: { kind: "settings", section: "terminal" } },
  { group: "Pages", label: "Settings › Browser", hint: "", target: { kind: "settings", section: "browser" } },
  { group: "Pages", label: "Settings › Environments", hint: "Simulated: four machines in every state, not the profile's", target: { kind: "settings", section: "environments" } },
  { group: "Pages", label: "Add a machine", hint: "The add-machine flow, simulated", target: { kind: "add-machine" } },
  { group: "Pages", label: "Settings › Providers", hint: "Simulated: versions, accounts and installs per machine", target: { kind: "settings", section: "providers" } },
  { group: "Pages", label: "Settings › Keybindings", hint: "", target: { kind: "settings", section: "keybindings" } },
  { group: "Pages", label: "Settings › About", hint: "Follows the simulated update", target: { kind: "settings", section: "about" } },

  // ── App update ─────────────────────────────────────────────
  { group: "App update", label: "Update available", hint: "The pill in the rail", target: { kind: "update", phase: "available" } },
  { group: "App update", label: "Update downloading", hint: "Ticks to 100%", target: { kind: "update", phase: "downloading" } },
  { group: "App update", label: "Update ready", hint: "Restart to update", target: { kind: "update", phase: "ready" } },
  { group: "App update", label: "No update", hint: "", target: { kind: "update", phase: "none" } },
];

export const STATES: ReviewState[] = RAW.map((state) => ({
  ...state,
  id: `${state.group}/${state.label}`.toLowerCase().replace(/[^a-z0-9/]+/g, "-"),
}));
