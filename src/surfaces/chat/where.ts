// Where a session runs, for the composer's context row
// and a new session's first screen: its workspace, its worktree's branch and
// its machine. It reads the app's shared place store, which the sidebar's
// hooks feed, and asks git itself only for a folder nobody has listed yet or
// when the window comes back, so a branch switched or a workspace renamed
// shows here as it does there.
import { useEffect, useSyncExternalStore } from "react";
import { useWorkspaceLink } from "../../hooks/useEnvLinks";
import { readTrees, readWorkspaces, subscribePlaces, mainBranchOf, treeKnown, treesSnapshot, watchPlaces, workspacesKnown } from "../../lib/placeStore";
import type { Session, Worktree } from "../../lib/types";
import { useChatActions } from "./context";

export type Where = {
  /** The workspace's name; undefined until it is read. */
  workspace?: string;
  /** The checkout the session works in; null outside git, undefined until git answers. */
  tree?: Worktree | null;
  /** The branch the repository's main checkout is on: the default one that work lands on. */
  base?: string;
  /** Whether the session works in Home, which is no project. */
  home?: boolean;
  /** The folder's last segment, for when there is no branch to name. */
  folder?: string;
  /** The machine's name; "This Mac" here. */
  machine: string;
  remote: boolean;
};

const trim = (path: string) => path.replace(/\/+$/, "");

export function useWhere(session: Pick<Session, "workspaceId">): Where {
  const { resolvePath } = useChatActions();
  return useWhereAt(trim(resolvePath("./") ?? ""), session.workspaceId);
}

/** Where a folder is, before any session runs in it: a workspace's first screen. */
export function useWhereAt(root: string, workspaceId: string): Where {
  const link = useWorkspaceLink(workspaceId);
  // Redrawn only when what it shows changes, not on every answer the store gets for some other folder.
  useSyncExternalStore(subscribePlaces, () => whereKey(root, workspaceId));
  const tree = root ? treeKnown(root) : undefined;
  const list = workspacesKnown();

  useEffect(() => {
    if (root && treeKnown(root) === undefined) void readTrees(root);
    if (workspacesKnown() === null) void readWorkspaces();
    return watchPlaces(root || null);
  }, [root]);

  const workspace = list?.find((one) => one.id === workspaceId);
  const name = workspace?.name;
  const base = root ? mainBranchOf(root) : null;
  return {
    ...(name ? { workspace: name } : {}),
    ...(base ? { base } : {}),
    ...(workspace?.home ? { home: true } : {}),
    ...(tree !== undefined ? { tree } : {}),
    ...(root ? { folder: root.split("/").pop() ?? root } : {}),
    machine: link?.name ?? "This Mac",
    remote: link !== null,
  };
}

/** What `useWhereAt` reads from the store, as one string that changes when it does. */
function whereKey(root: string, workspaceId: string): string {
  const workspace = workspacesKnown()?.find((one) => one.id === workspaceId);
  return JSON.stringify([root ? treeKnown(root) : undefined, workspace?.name, workspace?.home, root ? mainBranchOf(root) : null]);
}

/** The branch a session works on, when it is a branch worth naming. */
export function branchOf(where: Where): string | null {
  return where.tree?.branch ?? null;
}

/** Every checkout of the repository `root` is in, kept as fresh as `useWhere` keeps its own: what `#` can name. */
export function useRepoTrees(root: string): readonly Worktree[] {
  const key = trim(root);
  // Every mounted chat reads this: a list that stays the same object keeps them from redrawing whenever any repository is read.
  const trees = useSyncExternalStore(subscribePlaces, () => treesSnapshot(key));
  useEffect(() => {
    if (key && treeKnown(key) === undefined) void readTrees(key);
    return watchPlaces(key || null);
  }, [key]);
  return trees;
}
