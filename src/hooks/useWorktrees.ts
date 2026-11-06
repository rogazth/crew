import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { publishWorktrees } from "../lib/placeStore";
import type { Workspace, Worktree } from "../lib/types";
import { asListed } from "../lib/worktrees";

/** Until git answers, the workspace folder stands in as its only worktree. */
const standIn = (path: string): Worktree => ({ path, branch: null, main: true, add: 0, del: 0, dirty: 0, locked: null });

/**
 * The workspace's worktrees as git lists them. Read on every workspace switch
 * and whenever the window comes back, since worktrees are made and removed
 * outside crew too. Each workspace's last answer is kept, so switching back
 * shows it while git is asked again, which on a remote machine takes a moment.
 */
export function useWorktrees(workspace: Workspace | null) {
  const path = workspace?.path ?? "";
  // A few rows per workspace shown, so keeping them all costs next to nothing.
  const [listed, setListed] = useState<Record<string, Worktree[]>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const read = () =>
      void api
        .listWorktrees(path)
        .then((list) => !cancelled && setListed((prev) => ({ ...prev, [path]: list })))
        .catch(() => {});
    read();
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", read);
    };
  }, [path, tick]);

  const answer = listed[path];
  // The chat's context row reads the same answer.
  useEffect(() => {
    if (path && answer) publishWorktrees(path, answer);
  }, [path, answer]);
  const known = !!answer && answer.length > 0;
  const list = useMemo(
    () => (answer && answer.length > 0 ? asListed(answer, path) : path ? [standIn(path)] : []),
    [answer, path],
  );
  const main = list.find((tree) => tree.main) ?? list[0] ?? null;

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const create = useCallback(
    async (branch: string) => {
      const tree = await api.addWorktree(path, branch);
      setListed((prev) => (prev[path] ? { ...prev, [path]: [...prev[path], tree] } : prev));
      refresh();
      return tree;
    },
    [path, refresh],
  );

  /** Git's answer now, for a caller that cannot wait for the next focus. */
  const reread = useCallback(async () => {
    const fresh = await api.listWorktrees(path);
    setListed((prev) => ({ ...prev, [path]: fresh }));
    return asListed(fresh, path);
  }, [path]);

  const remove = useCallback(
    async (tree: Worktree, force: boolean) => {
      await api.removeWorktree(path, tree.path, force);
      setListed((prev) =>
        prev[path] ? { ...prev, [path]: prev[path].filter((entry) => entry.path !== tree.path) } : prev,
      );
      refresh();
    },
    [path, refresh],
  );

  return {
    list,
    /** Whether `list` is git's answer yet, or the workspace folder standing in for it. */
    known,
    /** The main checkout: where the window works when nothing on screen names a worktree. */
    main,
    refresh,
    reread,
    create,
    remove,
  };
}

export type Worktrees = ReturnType<typeof useWorktrees>;
