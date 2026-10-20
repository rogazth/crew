import { useCallback, useEffect, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { client } from "../lib/client";
import type { SessionCreated } from "../lib/protocol";
import { tabPlace } from "../lib/strips";
import type { PlaceOf } from "../lib/tabGroups";
import { lastUsed, sessionTabId } from "../lib/tabs";
import type { Session, Workspace } from "../lib/types";
import { placePath, sessionPath, unlistedWorktrees } from "../lib/worktrees";
import { useTabs } from "./useTabs";
import { useWorktrees } from "./useWorktrees";

/**
 * Where you are working: the workspace, the worktree inside it, and the tab
 * strip that goes with them. One strip holds the whole workspace's tabs, and
 * the tab on screen says which worktree you are in.
 */
export function useWorkContext(
  workspace: Workspace | null,
  sessions: Session[],
  everywhere: { workspaces: Workspace[]; sessions: Session[] },
) {
  const worktrees = useWorktrees(workspace);
  const chosen = worktrees.active;
  const context = workspace?.id ?? null;
  // With worktrees to tell apart, each tab names its own, for the pane's worktree line.
  const { known, list } = worktrees;
  const tabPlaceOf = useMemo<PlaceOf | null>(
    () =>
      workspace && known && list.length > 1
        ? (tab) => tabPlace(tab, workspace, list, sessions)
        : null,
    [known, list, sessions, workspace],
  );
  const tabs = useTabs(context, tabPlaceOf);

  // A session whose worktree git no longer lists works in the main checkout;
  // until git answers, its worktree is taken at its word.
  const listed = worktrees.known ? worktrees.list : null;
  const pathOf = useCallback(
    (session: Session) => (workspace ? sessionPath(session, workspace, listed) : null),
    [listed, workspace],
  );
  // A worktree an agent made shows up as a session in it first; git is asked
  // again once per new one, not on every render.
  const unlisted = workspace && listed ? unlistedWorktrees(sessions, workspace, listed) : "";
  const { refresh: rereadGit } = worktrees;
  useEffect(() => {
    if (unlisted) rereadGit();
  }, [unlisted, rereadGit]);

  /** The same for a worktree of any workspace, a session's or a strip's; only this one's are known. */
  const placeOf = useCallback(
    (worktree: string | null, of: Workspace) => placePath(worktree, of, of.id === workspace?.id ? listed : null),
    [listed, workspace?.id],
  );

  // The tab on screen names the worktree; a file or page tab leaves the chosen one, and
  // so does a bot's: it belongs to the workspace, so talking to it keeps you where you stand.
  const onScreen = tabs.active?.kind === "session" ? tabs.active.sessionId : null;
  const tabTree = onScreen ? sessions.find((s) => s.id === onScreen && s.kind !== "bot") : undefined;
  const tabPath = tabTree ? pathOf(tabTree) : null;
  const current = worktrees.list.find((tree) => tree.path === tabPath) ?? chosen;

  /** The worktree at `path` becomes current. */
  const routeTo = useCallback(
    (path: string | null) => {
      if (!path || path === current?.path) return;
      worktrees.select(path);
    },
    [current?.path, worktrees],
  );

  /** The same for the worktree `session` runs in; a bot belongs to the workspace and leaves you where you stand. */
  const route = useCallback(
    (session: Session) => {
      if (session.kind !== "bot") routeTo(pathOf(session));
    },
    [pathOf, routeTo],
  );

  /**
   * Going to a worktree brings up the tab last used there, or none, so the
   * strip agrees.
   */
  const selectWorktree = useCallback(
    (path: string) => {
      worktrees.select(path);
      tabs.selectLastUsed((tab) => {
        if (tab.kind !== "session") return false;
        const session = sessions.find((s) => s.id === tab.sessionId);
        return session !== undefined && pathOf(session) === path;
      });
    },
    [pathOf, sessions, tabs, worktrees],
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
      if (!target) return;
      const [own, strips] = await Promise.all([api.listSessions(workspaceId), tabs.strips([workspaceId])]);
      const tab = lastUsed(strips[workspaceId]!, (tab) => {
        if (tab.kind !== "session") return false;
        const session = own.find((s) => s.id === tab.sessionId);
        return session !== undefined && placePath(session.worktree, target, null) === path;
      });
      if (tab) tabs.selectIn(workspaceId, tab.id);
    },
    [everywhere.workspaces, tabs, worktrees],
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

  const latest = useRef({ tabs, everywhere });
  useEffect(() => {
    latest.current = { tabs, everywhere };
  });

  // A session handed to the user (`start_session`) joins its
  // workspace's strip behind whatever is on screen, and works on its prompt out of
  // sight: the window stays where it was.
  useEffect(() => {
    const unsubscribe = client.on("session-created", (payload) => {
      const { session, open } = payload as SessionCreated;
      const { tabs, everywhere } = latest.current;
      const of = everywhere.workspaces.find((ws) => ws.id === session.workspaceId);
      if (!open || !of) return;
      tabs.adopt(of.id, {
        id: sessionTabId(session.id),
        kind: "session",
        sessionId: session.id,
      });
    });
    return () => unsubscribe();
  }, []);

  return {
    worktrees,
    tabs,
    current,
    /** What a new session stores as its worktree: null for the main checkout. */
    placeIn: current && !current.main ? current.path : null,
    route,
    routeTo,
    selectWorktree,
    selectWorktreeIn,
    step,
    selectAt,
    pathOf,
    placeOf,
    tabPlaceOf,
  };
}
