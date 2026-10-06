import type { SessionLastEvent } from "./protocol";

export type Workspace = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Home: the window's own workspace in ~/Crew, not a project the user opened. */
  home?: boolean;
};

/**
 * What runs in a session. A bot is a persistent identity whose turns run in
 * its session; a terminal is a CLI the user drives; a child is a CLI another
 * session started with `start_session`, driven by Crew turn by turn.
 */
export type SessionKind = "bot" | "terminal" | "child";

/** Written by whatever runs the session: the terminal, or the daemon's turns. A child adds starting and exited. */
export type SessionStatus = "starting" | "idle" | "working" | "needs-input" | "done" | "error" | "exited";

/**
 * What it may do without asking: "ask" routes every tool through Allow/Deny,
 * "edits" lets file edits through, "auto" leaves routine actions to the
 * provider's own reviewer, "full" runs unattended.
 */
export type Autonomy = "ask" | "edits" | "auto" | "full";

export type Session = {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  name: string;
  provider: string;
  model: string;
  /** How hard its model thinks; empty is the CLI's own setting. */
  effort: string;
  providerSessionId: string | null;
  /** The git worktree it runs in; null is the workspace folder itself. */
  worktree: string | null;
  description: string;
  notifications: boolean;
  autonomy: Autonomy;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** The bot whose turns it runs; absent for a terminal and a child. */
  botId?: string;
  /** Whoever started it with `start_session`; absent when the user did. */
  parentId?: string;
  /** How far its transcript had got at its last event. */
  cursor?: number;
  /** The session that handed it to the user (`start_session` with owner user). */
  handedOffBy?: string;
  /** `handedOffBy`'s name now. */
  handedOffByName?: string;
  /** `parentId`'s name now. */
  parentName?: string;
  /** How far the user has read it, in `cursor` positions: `cursor > userSeen` is unread. */
  userSeen?: number;
  /** Its last event (a child's): with `status`, what its chip says. */
  lastEvent?: SessionLastEvent;
};

/** A git worktree of a workspace's repo. The main checkout comes first; outside git there is only it, branchless. */
export type Worktree = {
  path: string;
  branch: string | null;
  main: boolean;
  /** Lines added and removed against where the branch left the main checkout, uncommitted work included. */
  add: number;
  del: number;
  /** Entries `git status` lists. */
  dirty: number;
};

export type ProjectFile = {
  name: string;
  path: string;
  relative: string;
};

/** Surfaces that have chrome but no runtime yet. One tab kind covers them all. */
export const STUB_KINDS = ["terminal", "history", "commands"] as const;

export type StubKind = (typeof STUB_KINDS)[number];

/** A pinned tab keeps to the strip's left end, its face alone. */
export type Tab = (
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "file"; path: string; relative: string }
  /**
   * `url` and `title` are what a cold tab restores and labels itself with; the live page lives in `pages`.
   * An incognito page keeps nothing: no history, no saved stack, and its tab is never written to disk.
   */
  | {
      id: string;
      kind: "browser";
      url: string;
      title: string;
      /** Where the page's favicon lives, so a cold tab can show it before its page comes back. */
      icon?: string;
      incognito?: true;
      /**
       * A file the page renders, in the previews' session. Its URL is made
       * afresh each run, so the tab keeps the file and never a `url`.
       */
      file?: { path: string; relative: string };
    }
  /** A terminal keeps the worktree it was opened in; null or absent is the main checkout. */
  | { id: string; kind: "stub"; stub: StubKind; title: string; worktree?: string | null }
  /** One run of a workspace command: its output, in the worktree it runs in (null, the main checkout). */
  | { id: string; kind: "process"; processId: string; title: string; worktree: string | null }
) & { pinned?: true };
