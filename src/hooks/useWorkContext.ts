import { useCallback, useMemo } from "react";
import type { Session, Workspace } from "../lib/types";
import { contextId, sessionPath, worktreeHue } from "../lib/worktrees";
import { useTabScope } from "./useTabScope";
import { useTabs } from "./useTabs";
import { useWorktrees } from "./useWorktrees";

/**
 * Where you are working: the workspace, the worktree inside it, and the tab
 * strip that goes with them. Per worktree, each worktree has its own strip and
 * the worktree picks it. All together, one strip holds them all and the tab on
 * screen says which worktree you are in.
 */
export function useWorkContext(workspace: Workspace | null, sessions: Session[]) {
  const worktrees = useWorktrees(workspace);
  const { scope } = useTabScope();
  const chosen = worktrees.active;
  const context = workspace && chosen ? contextId(workspace, chosen.path, scope) : (workspace?.id ?? null);
  const tabs = useTabs(context);

  const pathOf = useCallback(
    (session: Session) => (workspace ? sessionPath(session, workspace) : null),
    [workspace],
  );

  // All together, the tab on screen names the worktree; a file or page tab leaves the chosen one.
  const onScreen = tabs.active?.kind === "session" ? tabs.active.sessionId : null;
  const tabTree = scope === "all" && onScreen ? sessions.find((s) => s.id === onScreen) : undefined;
  const tabPath = tabTree ? pathOf(tabTree) : null;
  const current = worktrees.list.find((tree) => tree.path === tabPath) ?? chosen;

  /** The worktree `session` runs in becomes current; the answer says which strip its tab joins. */
  const route = useCallback(
    (session: Session) => {
      const path = pathOf(session);
      if (!workspace || !path || path === current?.path) return null;
      worktrees.select(path);
      const target = contextId(workspace, path, scope);
      return { context: target === context ? null : target };
    },
    [context, current?.path, pathOf, scope, workspace, worktrees],
  );

  /** All together, going to a worktree brings up its latest tab, or none, so the strip agrees. */
  const selectWorktree = useCallback(
    (path: string) => {
      worktrees.select(path);
      if (scope !== "all") return;
      const own = [...tabs.tabs].reverse().find((tab) => {
        if (tab.kind !== "session") return false;
        const session = sessions.find((s) => s.id === tab.sessionId);
        return session !== undefined && pathOf(session) === path;
      });
      tabs.select(own?.id ?? null);
    },
    [pathOf, scope, sessions, tabs, worktrees],
  );

  const step = useCallback(
    (delta: number) => {
      const list = worktrees.list;
      const at = list.findIndex((tree) => tree.path === current?.path);
      const next = list[(((at + delta) % list.length) + list.length) % list.length];
      if (list.length > 1 && next) selectWorktree(next.path);
    },
    [current?.path, selectWorktree, worktrees.list],
  );

  const selectAt = useCallback(
    (index: number) => {
      const target = worktrees.list[index];
      if (target) selectWorktree(target.path);
    },
    [selectWorktree, worktrees.list],
  );

  /** Each worktree's hue, by its place in the list, for tab chips and the context bar. */
  const hues = useMemo(
    () => new Map(worktrees.list.map((tree, index) => [tree.path, worktreeHue(index)])),
    [worktrees.list],
  );

  return {
    worktrees,
    scope,
    tabs,
    current,
    /** What a new session stores as its worktree: null for the main checkout. */
    placeIn: current && !current.main ? current.path : null,
    route,
    selectWorktree,
    step,
    selectAt,
    hues,
    pathOf,
  };
}
