// Where a session runs, for the composer's context row
// and a new session's first screen: its workspace, its worktree's branch and
// its machine. Read once per folder and kept for the window's life; a branch
// switched under it shows on the next launch.
import { useEffect, useState } from "react";
import { useWorkspaceLink } from "../../hooks/useEnvLinks";
import { listWorkspaces, listWorktrees } from "../../lib/api";
import type { Session, Workspace, Worktree } from "../../lib/types";
import { useChatActions } from "./context";

export type Where = {
  /** The workspace's name; undefined until it is read. */
  workspace?: string;
  /** The checkout the session works in; null outside git, undefined until git answers. */
  tree?: Worktree | null;
  /** The folder's last segment, for when there is no branch to name. */
  folder?: string;
  /** The machine's name; "This Mac" here. */
  machine: string;
  remote: boolean;
};

const trees = new Map<string, Promise<Worktree | null>>();
let workspaces: Promise<Workspace[]> | null = null;
// What the reads above already answered, for a chat mounted after them to draw on its first frame:
// waiting on the settled promise again would add the branch a frame late, and the facts would jump.
const treesRead = new Map<string, Worktree | null>();
let workspacesRead: Workspace[] | null = null;

const trim = (path: string) => path.replace(/\/+$/, "");

function treeOf(root: string): Promise<Worktree | null> {
  let found = trees.get(root);
  if (!found) {
    found = listWorktrees(root).then(
      (list) => list.find((tree) => trim(tree.path) === root) ?? null,
      () => null,
    );
    void found.then((tree) => treesRead.set(root, tree));
    trees.set(root, found);
  }
  return found;
}

function workspaceName(id: string): Promise<string | undefined> {
  workspaces ??= listWorkspaces()
    .catch(() => [])
    .then((list) => (workspacesRead = list));
  return workspaces.then((list) => list.find((workspace) => workspace.id === id)?.name);
}

export function useWhere(session: Pick<Session, "workspaceId">): Where {
  const { resolvePath } = useChatActions();
  const root = trim(resolvePath("./") ?? "");
  const link = useWorkspaceLink(session.workspaceId);
  const [tree, setTree] = useState<{ root: string; tree: Worktree | null } | null>(null);
  const [workspace, setWorkspace] = useState<{ id: string; name: string | undefined } | null>(null);

  useEffect(() => {
    if (!root) return;
    let live = true;
    void treeOf(root).then((found) => live && setTree({ root, tree: found }));
    return () => {
      live = false;
    };
  }, [root]);

  useEffect(() => {
    let live = true;
    void workspaceName(session.workspaceId).then((name) => live && setWorkspace({ id: session.workspaceId, name }));
    return () => {
      live = false;
    };
  }, [session.workspaceId]);

  const name =
    workspace?.id === session.workspaceId
      ? workspace.name
      : workspacesRead?.find((one) => one.id === session.workspaceId)?.name;
  const read = tree && tree.root === root ? { tree: tree.tree } : treesRead.has(root) ? { tree: treesRead.get(root) ?? null } : {};
  return {
    ...(name ? { workspace: name } : {}),
    ...read,
    ...(root ? { folder: root.split("/").pop() ?? root } : {}),
    machine: link?.name ?? "This Mac",
    remote: link !== null,
  };
}

/** The branch a session works on, when it is a branch worth naming. */
export function branchOf(where: Where): string | null {
  return where.tree?.branch ?? null;
}
