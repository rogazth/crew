import type { Session, Workspace, Worktree } from "./types";

/** Whether the tab strip follows the worktree on screen, or holds the whole workspace's tabs. */
export type TabScope = "worktree" | "all";

/**
 * Where a session runs: its worktree while git lists it, else the main
 * checkout. `worktrees` is git's list, null until git answers, when the
 * session's worktree is taken at its word. The session keeps its worktree:
 * made again, the worktree is the session's again.
 */
export function sessionPath(session: Session, workspace: Workspace, worktrees: Worktree[] | null): string {
  return placePath(session.worktree, workspace, worktrees);
}

/** The same rule for anything kept in a worktree, a tab strip too; null is the main checkout. */
export function placePath(worktree: string | null, workspace: Workspace, worktrees: Worktree[] | null): string {
  if (!worktree || (worktrees && !worktrees.some((entry) => entry.path === worktree))) return workspace.path;
  return worktree;
}

/**
 * A workspace's worktrees as git lists them, the main checkout answering to the
 * workspace's own path: git may spell it resolved (/private/…), and sessions
 * with no worktree run in the workspace folder.
 */
export function asListed(list: Worktree[], workspacePath: string): Worktree[] {
  return list.map((tree) => (tree.main ? { ...tree, path: workspacePath } : tree));
}

/**
 * The key a tab strip is stored and mounted under. The main checkout shares the
 * workspace's own key, so the tabs a workspace had before worktrees stay put;
 * every other worktree gets its own strip unless tabs are kept together.
 */
export function contextId(workspace: Workspace, worktreePath: string, scope: TabScope): string {
  if (scope === "all" || worktreePath === workspace.path) return workspace.id;
  return `${workspace.id}@${worktreePath}`;
}

/** The workspace id and, for a worktree's own strip, its path. */
export function parseContext(id: string): { workspaceId: string; worktree: string | null } {
  const at = id.indexOf("@");
  return at < 0
    ? { workspaceId: id, worktree: null }
    : { workspaceId: id.slice(0, at), worktree: id.slice(at + 1) };
}

/** What a worktree is called: its branch, or where its HEAD stands when it has none. */
export function worktreeLabel(tree: Worktree): string {
  return tree.branch ?? (tree.main ? "No branch" : "Detached");
}

/** The last segment of a branch, for chips too small for the whole name. */
export function shortBranch(tree: Worktree): string {
  const label = worktreeLabel(tree);
  return label.split("/").pop() ?? label;
}

const HUES = [250, 150, 25, 300, 80, 190];

/** A stable hue per worktree, so a tab's chip and its sidebar line agree. */
export function worktreeHue(index: number): number {
  return HUES[((index % HUES.length) + HUES.length) % HUES.length]!;
}

/** The worktree a session runs in, from the list git gave; the main checkout when its own is gone. */
export function worktreeOf(session: Session, workspace: Workspace, worktrees: Worktree[]): Worktree | undefined {
  const path = sessionPath(session, workspace, worktrees);
  return worktrees.find((tree) => tree.path === path) ?? worktrees.find((tree) => tree.main);
}

/** Git refuses branch names with spaces and a few symbols; this catches the common ones before it does. */
export function branchError(branch: string): string | null {
  const name = branch.trim();
  if (!name) return "Branch is required";
  if (/[\s~^:?*[\\]|\.\.|@\{|\/$|^\/|\.lock$/.test(name)) return "Not a valid branch name";
  return null;
}

/** What removing a worktree takes with it, for the prompt that asks. Git keeps the branch. */
export function removalCost(dirty: number, sessions: number): string {
  return [
    dirty > 0
      ? `${dirty} uncommitted ${dirty === 1 ? "change is" : "changes are"} lost with the folder.`
      : "The folder is deleted; the branch stays.",
    sessions > 0 ? `${sessions} ${sessions === 1 ? "session ends" : "sessions end"} with it.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** crewd refusing an unforced removal over work git sees and the listing did not. */
export function isDirtyRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(" has uncommitted changes");
}
