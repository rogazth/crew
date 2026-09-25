import { useCallback, useEffect, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { joinStrips, splitStrip, tabPlace } from "../lib/strips";
import { lastUsed, type TabRegistry } from "../lib/tabs";
import type { Session, Tab, Workspace, Worktree } from "../lib/types";
import { asListed, contextId, placePath, sessionPath, worktreeHue, type TabScope } from "../lib/worktrees";
import { useTabRegroup, useTabScope } from "./useTabScope";
import { useTabs } from "./useTabs";
import { useWorktrees } from "./useWorktrees";

/**
 * Where you are working: the workspace, the worktree inside it, and the tab
 * strip that goes with them. Per worktree, each worktree has its own strip and
 * the worktree picks it. All together, one strip holds them all and the tab on
 * screen says which worktree you are in.
 */
export function useWorkContext(
  workspace: Workspace | null,
  sessions: Session[],
  everywhere: { workspaces: Workspace[]; sessions: Session[] },
) {
  const worktrees = useWorktrees(workspace);
  const { scope } = useTabScope();
  const chosen = worktrees.active;
  const context = workspace && chosen ? contextId(workspace, chosen.path, scope) : (workspace?.id ?? null);
  const tabs = useTabs(context);

  // A session whose worktree git no longer lists works in the main checkout;
  // until git answers, its worktree is taken at its word.
  const listed = worktrees.known ? worktrees.list : null;
  const pathOf = useCallback(
    (session: Session) => (workspace ? sessionPath(session, workspace, listed) : null),
    [listed, workspace],
  );
  /** The same for a worktree of any workspace, a session's or a strip's; only this one's are known. */
  const placeOf = useCallback(
    (worktree: string | null, of: Workspace) => placePath(worktree, of, of.id === workspace?.id ? listed : null),
    [listed, workspace?.id],
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

  /**
   * All together, going to a worktree brings up the tab last used there, or
   * none, so the strip agrees. Per worktree its own strip already shows it.
   */
  const selectWorktree = useCallback(
    (path: string) => {
      worktrees.select(path);
      if (scope !== "all") return;
      tabs.selectLastUsed((tab) => {
        if (tab.kind !== "session") return false;
        const session = sessions.find((s) => s.id === tab.sessionId);
        return session !== undefined && pathOf(session) === path;
      });
    },
    [pathOf, scope, sessions, tabs, worktrees],
  );

  /**
   * The same for a worktree of another workspace, before it shows. Its strip
   * and sessions may not be in this window yet, so they are read first; a
   * worktree with no tab there leaves the strip as it is.
   */
  const selectWorktreeIn = useCallback(
    async (workspaceId: string, path: string) => {
      worktrees.select(path, workspaceId);
      const target = everywhere.workspaces.find((ws) => ws.id === workspaceId);
      if (scope !== "all" || !target) return;
      const [own, strips] = await Promise.all([api.listSessions(workspaceId), tabs.strips([workspaceId])]);
      const tab = lastUsed(strips[workspaceId]!, (tab) => {
        if (tab.kind !== "session") return false;
        const session = own.find((s) => s.id === tab.sessionId);
        return session !== undefined && placePath(session.worktree, target, null) === path;
      });
      if (tab) tabs.selectIn(workspaceId, tab.id);
    },
    [everywhere.workspaces, scope, tabs, worktrees],
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

  // Switching between tabs per worktree and all together rearranges every
  // workspace's strips: this one's as the screen has them, the others' as crewd
  // keeps them.
  const latest = useRef({ workspace, current, tabs, worktrees, everywhere });
  useEffect(() => {
    latest.current = { workspace, current, tabs, worktrees, everywhere };
  });
  const regroup = useCallback(async (to: TabScope, commit: () => void) => {
    const { workspace: shown, current: here, tabs, worktrees, everywhere } = latest.current;
    const plans = await Promise.all(
      everywhere.workspaces.map((ws) => {
        const mine = ws.id === shown?.id;
        const own = everywhere.sessions.filter((session) => session.workspaceId === ws.id);
        return Promise.all([
          mine && worktrees.known ? worktrees.list : api.listWorktrees(ws.path).then((list) => asListed(list, ws.path)),
          mine ? (here?.path ?? null) : api.stateGet(`worktree:${ws.id}`),
        ])
          .then(([list, stored]) => regroupOne(ws, list, stored, own, to, tabs.strips))
          // A workspace git cannot list keeps its strips as they are.
          .catch(() => null);
      }),
    );
    const next: TabRegistry = {};
    const gone: string[] = [];
    for (const plan of plans) {
      if (!plan) continue;
      Object.assign(next, plan.next);
      gone.push(...plan.gone);
      if (plan.select) worktrees.select(plan.select, plan.workspaceId);
    }
    tabs.replace(next, gone);
    commit();
  }, []);
  useTabRegroup(regroup);

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
    selectWorktreeIn,
    step,
    selectAt,
    hues,
    pathOf,
    placeOf,
  };
}

/**
 * One workspace's strips for a new scope. Per worktree to all together, its
 * worktrees' strips join into the workspace's, the one on screen staying on
 * screen. Back, the joined strip splits into theirs, and the worktree that
 * holds the tab on screen is the one to show. `stored` is the worktree chosen
 * before the switch, when there is one.
 */
async function regroupOne(
  workspace: Workspace,
  list: Worktree[],
  stored: string | null,
  sessions: Session[],
  to: TabScope,
  read: (ids: string[]) => Promise<TabRegistry>,
) {
  const paths = [workspace.path, ...list.flatMap((tree) => (tree.main ? [] : [tree.path]))];
  const chosen = paths.find((path) => path === stored) ?? workspace.path;
  const strip = (path: string) => contextId(workspace, path, "worktree");
  const placeOf = (tab: Tab) => tabPlace(tab, workspace, list, sessions);

  if (to === "all") {
    const ids = paths.map(strip);
    const strips = await read(ids);
    const joined = joinStrips(ids.map((id) => strips[id]!), strips[strip(chosen)]?.activeId ?? null);
    const gone = ids.filter((id) => id !== workspace.id);
    return { workspaceId: workspace.id, next: { [workspace.id]: joined }, gone, select: null };
  }

  const joined = (await read([workspace.id]))[workspace.id]!;
  // All together, the session on screen says which worktree is current.
  const onScreen = joined.tabs.find((tab) => tab.id === joined.activeId);
  const current = (onScreen?.kind === "session" && placeOf(onScreen)) || chosen;
  const split = splitStrip(joined, paths, current, placeOf);
  const next = Object.fromEntries([...split].map(([path, state]) => [strip(path), state]));
  const select = (onScreen && placeOf(onScreen)) || current;
  return { workspaceId: workspace.id, next, gone: [], select: paths.includes(select) ? select : current };
}
