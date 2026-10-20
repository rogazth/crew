// What the app last learned about the workspaces and the checkouts under
// them, shared by whoever reads it: the sidebar's hooks publish every answer
// they get, and the chat's context row reads the same one, so a branch
// switched or a workspace renamed shows where it is used without a launch.
import type { Workspace, Worktree } from "./types";

const trim = (path: string) => path.replace(/\/+$/, "");

let workspaces: Workspace[] | null = null;
const trees = new Map<string, Worktree | null>();
/** Which repository answered for a checkout, so a checkout it stops listing is told apart from one it never spoke for. */
const repoOf = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function bump() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Changes whenever anything below does, for useSyncExternalStore. */
export const placesVersion = () => version;

export const workspacesKnown = () => workspaces;

/** The checkout at `root`: undefined until asked, null when it is not one git lists. */
export const treeKnown = (root: string): Worktree | null | undefined => trees.get(trim(root));

export function publishWorkspaces(list: Workspace[]) {
  workspaces = list;
  bump();
}

/** git's list for the repository at `root`: every checkout in it becomes known, and one that is gone no longer is. */
export function publishWorktrees(root: string, list: Worktree[]) {
  const wanted = trim(root);
  const paths = new Set(list.map((tree) => trim(tree.path)));
  paths.add(wanted);
  const group = [...paths].find((path) => repoOf.has(path)) ?? wanted;
  const repo = repoOf.get(group) ?? wanted;
  for (const [path, owner] of repoOf) if (owner === repo && !paths.has(path)) trees.set(path, null);
  for (const path of paths) repoOf.set(path, repo);
  for (const path of paths) trees.set(path, null);
  for (const tree of list) trees.set(trim(tree.path), tree);
  bump();
}

/** The branch the repository's main checkout is on, which is where its work lands: the real default, not a guess. */
export function mainBranchOf(root: string): string | null {
  const repo = repoOf.get(trim(root));
  if (!repo) return null;
  for (const [path, owner] of repoOf) {
    const tree = owner === repo ? trees.get(path) : null;
    if (tree?.main && tree.branch) return tree.branch;
  }
  return null;
}
