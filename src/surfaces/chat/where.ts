// Where a session runs, for the composer's context row
// and a new session's first screen: its workspace, its worktree's branch and
// its machine. It reads the app's shared place store, which the sidebar's
// hooks feed, and asks git itself only for a folder nobody has listed yet or
// when the window comes back, so a branch switched or a workspace renamed
// shows here as it does there.
import { useEffect, useSyncExternalStore } from "react";
import { useWorkspaceLink } from "../../hooks/useEnvLinks";
import { placesVersion, readTrees, readWorkspaces, subscribePlaces, mainBranchOf, treeKnown, watchPlaces, workspacesKnown } from "../../lib/placeStore";
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
  const root = trim(resolvePath("./") ?? "");
  const link = useWorkspaceLink(session.workspaceId);
  useSyncExternalStore(subscribePlaces, placesVersion);
  const tree = root ? treeKnown(root) : undefined;
  const list = workspacesKnown();

  useEffect(() => {
    if (root && treeKnown(root) === undefined) void readTrees(root);
    if (workspacesKnown() === null) void readWorkspaces();
    return watchPlaces(root || null);
  }, [root]);

  const workspace = list?.find((one) => one.id === session.workspaceId);
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

/** The branch a session works on, when it is a branch worth naming. */
export function branchOf(where: Where): string | null {
  return where.tree?.branch ?? null;
}
