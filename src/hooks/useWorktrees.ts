import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import type { Workspace, Worktree } from "../lib/types";

const activeKey = (workspaceId: string) => `worktree:${workspaceId}`;

/** Until git answers, the workspace folder stands in as its only worktree. */
const standIn = (path: string): Worktree => ({ path, branch: null, main: true, add: 0, del: 0, dirty: 0 });

/**
 * The workspace's worktrees as git lists them, and the one on screen. Read on
 * every workspace switch and whenever the window comes back, since worktrees
 * are made and removed outside crew too. The one on screen is remembered per
 * workspace.
 */
export function useWorktrees(workspace: Workspace | null) {
  const path = workspace?.path ?? "";
  const workspaceId = workspace?.id ?? "";
  const [listed, setListed] = useState<{ path: string; list: Worktree[] }>({ path, list: [] });
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const read = () =>
      void api
        .listWorktrees(path)
        .then((list) => !cancelled && setListed({ path, list }))
        .catch(() => {});
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [path, tick]);

  useEffect(() => {
    if (!workspaceId || chosen[workspaceId] !== undefined) return;
    let cancelled = false;
    void api
      .stateGet(activeKey(workspaceId))
      .then((raw) => !cancelled && setChosen((prev) => ({ ...prev, [workspaceId]: raw ?? "" })))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chosen]);

  // The main checkout answers to the workspace's own path: git may spell it
  // resolved (/private/…), and sessions with no worktree run in the workspace folder.
  const list = useMemo(
    () =>
      listed.path === path && listed.list.length > 0
        ? listed.list.map((tree) => (tree.main ? { ...tree, path } : tree))
        : path
          ? [standIn(path)]
          : [],
    [listed, path],
  );
  // A remembered worktree that git no longer lists falls back to the main checkout.
  const active = list.find((tree) => tree.path === chosen[workspaceId]) ?? list.find((tree) => tree.main) ?? list[0] ?? null;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  /** Another workspace's worktree can be chosen too, ahead of switching to it. */
  const select = useCallback(
    (treePath: string, inWorkspace: string = workspaceId) => {
      if (!inWorkspace) return;
      setChosen((prev) => ({ ...prev, [inWorkspace]: treePath }));
      void api.stateSet(activeKey(inWorkspace), treePath).catch(() => {});
    },
    [workspaceId],
  );

  /** The keyboard walks the sidebar order and wraps, like tab cycling. */
  const step = useCallback(
    (delta: number) => {
      if (list.length < 2 || !active) return;
      const index = list.findIndex((tree) => tree.path === active.path);
      const next = list[(((index + delta) % list.length) + list.length) % list.length];
      if (next) select(next.path);
    },
    [active, list, select],
  );

  const selectAt = useCallback(
    (index: number) => {
      const target = list[index];
      if (target) select(target.path);
    },
    [list, select],
  );

  const create = useCallback(
    async (branch: string) => {
      const tree = await api.addWorktree(path, branch);
      setListed((prev) => (prev.path === path ? { path, list: [...prev.list, tree] } : prev));
      select(tree.path);
      refresh();
      return tree;
    },
    [path, refresh, select],
  );

  const remove = useCallback(
    async (tree: Worktree, force: boolean) => {
      await api.removeWorktree(tree.path, force);
      setListed((prev) => ({ ...prev, list: prev.list.filter((entry) => entry.path !== tree.path) }));
      refresh();
    },
    [refresh],
  );

  return { list, active, refresh, select, step, selectAt, create, remove };
}

export type Worktrees = ReturnType<typeof useWorktrees>;
