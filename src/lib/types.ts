export type Workspace = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
};

export type SessionKind = "agent" | "terminal";

/** Written by whatever runs the session: the terminal today, the agent runtime later. */
export type SessionStatus = "idle" | "working" | "needs-input" | "done" | "error";

/** "ask" routes every tool through Allow/Deny; "full" lets the provider run unattended. */
export type Autonomy = "ask" | "full";

export type Session = {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  name: string;
  provider: string;
  model: string;
  providerSessionId: string | null;
  /** The git worktree it runs in; null is the workspace folder itself. */
  worktree: string | null;
  description: string;
  notifications: boolean;
  autonomy: Autonomy;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
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
export const STUB_KINDS = ["terminal", "history"] as const;

export type StubKind = (typeof STUB_KINDS)[number];

export type Tab =
  | { id: string; kind: "session"; sessionId: string }
  | { id: string; kind: "file"; path: string; relative: string }
  /** `url` and `title` are what a cold tab restores and labels itself with; the live page lives in `pages`. */
  | { id: string; kind: "browser"; url: string; title: string }
  | { id: string; kind: "stub"; stub: StubKind; title: string };
