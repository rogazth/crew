// PROTOTYPE — throwaway. Where a session runs, for the composer's context row
// and a new session's first screen: its workspace, its worktree's branch and
// its machine. Read once per folder and kept for the window's life; a branch
// switched under it shows on the next launch, which is fine for a prototype.
import { useEffect, useState } from "react";
import { useWorkspaceLink } from "../../../hooks/useEnvLinks";
import { listWorkspaces, listWorktrees } from "../../../lib/api";
import type { Session, Workspace, Worktree } from "../../../lib/types";
import { useChatActions } from "../../../surfaces/chat/context";

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

const trim = (path: string) => path.replace(/\/+$/, "");

function treeOf(root: string): Promise<Worktree | null> {
  let found = trees.get(root);
  if (!found) {
    found = listWorktrees(root).then(
      (list) => list.find((tree) => trim(tree.path) === root) ?? null,
      () => null,
    );
    trees.set(root, found);
  }
  return found;
}

function workspaceName(id: string): Promise<string | undefined> {
  workspaces ??= listWorkspaces().catch(() => []);
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

  const name = workspace?.id === session.workspaceId ? workspace.name : undefined;
  return {
    ...(name ? { workspace: name } : {}),
    ...(tree && tree.root === root ? { tree: tree.tree } : {}),
    ...(root ? { folder: root.split("/").pop() ?? root } : {}),
    machine: link?.name ?? "This Mac",
    remote: link !== null,
  };
}

/** The branch a session works on, when it is a branch worth naming. */
export function branchOf(where: Where): string | null {
  return where.tree?.branch ?? null;
}
