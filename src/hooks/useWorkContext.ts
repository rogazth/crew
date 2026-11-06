import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../lib/client";
import type { SessionCreated } from "../lib/protocol";
import { tabPlace } from "../lib/strips";
import type { PlaceOf } from "../lib/tabGroups";
import { sessionTabId } from "../lib/tabs";
import type { Session, Workspace } from "../lib/types";
import { placePath, sessionPath, unlistedWorktrees } from "../lib/worktrees";
import { useTabs } from "./useTabs";
import { useWorktrees } from "./useWorktrees";

/**
 * Where you are working: the workspace, the worktree inside it, and the tab
 * strip that goes with them. One strip holds the whole workspace's tabs, and
 * the tab on screen says which worktree you are in; no worktree is chosen
 * apart from it. With no tab up, the start screen's place does, else the main
 * checkout.
 */
export function useWorkContext(
  workspace: Workspace | null,
  sessions: Session[],
  everywhere: { workspaces: Workspace[]; sessions: Session[] },
) {
  const worktrees = useWorktrees(workspace);
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

  // The tab on screen names the worktree; one with no place (a page, a bot's tab) is the main checkout's.
  const onScreen = tabs.active && workspace ? tabPlace(tabs.active, workspace, list, sessions) : null;
  /** The worktree the start screen starts in, when it was asked for one; it lasts until a tab comes up. */
  const [startIn, setStartIn] = useState<string | null>(null);
  const tabUp = tabs.active !== null;
  useEffect(() => {
    if (tabUp) setStartIn(null);
  }, [tabUp]);
  useEffect(() => setStartIn(null), [context]);
  const here = onScreen ?? (tabUp ? null : startIn);
  const current = list.find((tree) => tree.path === here) ?? worktrees.main;

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
    setStartIn,
    pathOf,
    placeOf,
    tabPlaceOf,
  };
}
