import type { Session, Tab, Workspace, Worktree } from "./types";
import { placePath, sessionPath } from "./worktrees";

/**
 * The worktree a tab belongs to, when it has one: a session's is where it
 * runs, a file's is the worktree whose folder holds it, else the main
 * checkout. Pages and the rest belong to none.
 */
export function tabPlace(tab: Tab, workspace: Workspace, worktrees: Worktree[], sessions: Session[]): string | null {
  if (tab.kind === "session") {
    const session = sessions.find((s) => s.id === tab.sessionId);
    // A bot belongs to the workspace, not to a worktree: its tab joins no group.
    return session && session.kind !== "bot" ? sessionPath(session, workspace, worktrees) : null;
  }
  if (tab.kind === "stub") return tab.worktree !== undefined ? placePath(tab.worktree, workspace, worktrees) : null;
  if (tab.kind === "process") return placePath(tab.worktree, workspace, worktrees);
  if (tab.kind !== "file") return null;
  // The deepest folder wins: a worktree can sit inside the main checkout.
  const holders = worktrees.filter((tree) => tab.path.startsWith(`${tree.path}/`));
  return holders.reduce<string | null>((deepest, tree) => (tree.path.length > (deepest?.length ?? 0) ? tree.path : deepest), null) ?? workspace.path;
}
