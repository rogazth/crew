import { useCallback, useEffect } from "react";
import { requestRoute, routeAgent } from "../lib/agentRoute";
import * as api from "../lib/api";
import { fileView } from "../lib/browser/files";
import { fileTabId, newBrowserTab, newFileBrowserTab, newSignInTab, newTerminalTab, processTabId, sessionTabId, stubTabId } from "../lib/tabs";
import { discardEdits, fileName, unsavedTabs } from "../lib/unsavedEdits";
import type { Process } from "../lib/processes";
import type { ProjectFile, Session, StubKind } from "../lib/types";
import type { useConfirmations } from "./useConfirmations";
import type { useTabs } from "./useTabs";

type Deps = {
  tabs: ReturnType<typeof useTabs>;
  sessions: Session[];
  confirms: ReturnType<typeof useConfirmations>;
  removeSession: (id: string) => Promise<void>;
  closePage: () => void;
  /**
   * Opening a session's tab makes the worktree it runs in current.
   */
  route: (session: Session) => void;
  /** The same for a worktree by its folder: a command's run belongs to the worktree it runs in. */
  routeTo: (path: string | null) => void;
  /** The main checkout's folder, for a run that is its. */
  root: string | null;
};

/**
 * Everything that brings a tab to the front. Pages stack over the tabs, so each
 * of these leaves the page first.
 */
export function useNavigation({ tabs, sessions, confirms, removeSession, closePage, route, routeTo, root }: Deps) {
  /** Wraps a tab action so it lands in view instead of behind whatever page is up. */
  const inTabs = useCallback(
    (act: () => void) => () => {
      closePage();
      act();
    },
    [closePage],
  );

  const openTabOf = useCallback(
    (session: Session) => {
      closePage();
      const tab = { id: sessionTabId(session.id), kind: "session" as const, sessionId: session.id };
      route(session);
      tabs.open(tab);
    },
    [closePage, route, tabs],
  );

  /**
   * A subagent never has a tab: it opens as a thread in its parent's (the top
   * owner's, for a subagent of a subagent). Anything else has its own.
   */
  const openSession = useCallback(
    (session: Session, focus?: string) => {
      const owner = routeAgent(session, sessions);
      if (!owner) return openTabOf(session);
      requestRoute(owner, focus);
      openTabOf(owner.root);
    },
    [openTabOf, sessions],
  );

  // A subagent's tab from an older layout becomes its parent's, with the thread open when it was in front.
  useEffect(() => {
    for (const tab of tabs.tabs) {
      if (tab.kind !== "session") continue;
      const session = sessions.find((row) => row.id === tab.sessionId);
      const owner = session && routeAgent(session, sessions);
      if (!owner) continue;
      if (tabs.active?.id === tab.id) requestRoute(owner);
      tabs.childToParent(tab.id, { id: sessionTabId(owner.root.id), kind: "session", sessionId: owner.root.id });
    }
  }, [sessions, tabs]);

  /** A message from a bot names its sender; the name opens its tab. */
  const openSessionById = useCallback(
    (id: string) => {
      const found = sessions.find((session) => session.id === id);
      if (found) openSession(found);
    },
    [sessions, openSession],
  );

  /** A PDF or a video opens in a page; anything else in the editor or the image viewer. */
  const openFile = useCallback(
    (file: ProjectFile) => {
      closePage();
      if (fileView(file.relative) === "browser") tabs.open(newFileBrowserTab(file.path, file.relative));
      else tabs.open({ id: fileTabId(file.path), kind: "file", path: file.path, relative: file.relative });
    },
    [closePage, tabs],
  );

  /** An HTML file rendered in a page, its editor left open. */
  const openFileInBrowser = useCallback(
    (file: { path: string; relative: string }) => {
      closePage();
      tabs.open(newFileBrowserTab(file.path, file.relative));
    },
    [closePage, tabs],
  );

  const openStub = useCallback(
    (stub: StubKind, title: string) => {
      closePage();
      tabs.open({ id: stubTabId(stub), kind: "stub", stub, title });
    },
    [closePage, tabs],
  );

  /** Every call is a new shell; null opens it in the main checkout. */
  const openTerminal = useCallback(
    (worktree: string | null) => {
      closePage();
      tabs.open(newTerminalTab(worktree));
    },
    [closePage, tabs],
  );

  /** A new shell in a workspace's main checkout, on screen or not: the tab waits for the workspace's saved tabs. */
  const openTerminalIn = useCallback(
    (workspaceId: string, input?: string) => {
      closePage();
      tabs.openIn(workspaceId, newTerminalTab(null, input));
    },
    [closePage, tabs],
  );

  /**
   * An MCP server's login for a session, run in a terminal tab of the session's worktree; its end has the
   * session connect the server. Every call is a new shell.
   */
  const openSignIn = useCallback(
    (sessionId: string, server: string, command: string[]) => {
      const session = sessions.find((row) => row.id === sessionId);
      if (!session) return;
      closePage();
      const tab = newSignInTab(session.worktree, { sessionId, server, command });
      route(session);
      tabs.open(tab);
    },
    [closePage, route, sessions, tabs],
  );

  /** A command's run, in a tab; the same run again comes back to its tab. */
  const openProcessRun = useCallback(
    (process: Process, worktree: string | null) => {
      closePage();
      const tab = { id: processTabId(process.id, worktree), kind: "process" as const, processId: process.id, title: process.name, worktree };
      routeTo(worktree ?? root);
      tabs.open(tab);
    },
    [closePage, root, routeTo, tabs],
  );

  /** Every call is a new tab: pages have no natural key to dedupe on. */
  const openBrowser = useCallback(
    (url = "", incognito = false) => {
      closePage();
      tabs.open(newBrowserTab(url, incognito));
    },
    [closePage, tabs],
  );

  /**
   * A session tab that never held a turn goes with its session; any other
   * leaves the session in the sidebar, a terminal's CLI running on. Files with
   * unsaved edits ask first, once for the whole batch; closing discards the edits.
   */
  const closeTabs = useCallback(
    (ids: string[]) => {
      const wanted = new Set(ids);
      const targets = tabs.tabs.filter((tab) => wanted.has(tab.id));
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const owned = new Map<string, Session>();
      for (const tab of targets) {
        const session = tab.kind === "session" ? byId.get(tab.sessionId) : undefined;
        if (session) owned.set(tab.id, session);
      }
      if (targets.length === 0) return;
      const unsaved = unsavedTabs(targets);
      confirms.askCloseTabs(
        unsaved.map(fileName),
        targets.length,
        () => {
          // Before the tabs go: an editor on screen must not keep them as it unmounts.
          for (const tab of unsaved) discardEdits(tab.path);
          for (const tab of targets) {
            const session = owned.get(tab.id);
            if (!session) {
              tabs.close(tab.id);
              continue;
            }
            void api
              .isSessionDisposable(session.id)
              .catch(() => false)
              .then(async (disposable) => {
                if (!disposable) return tabs.close(tab.id);
                tabs.closeForSession(session.id);
                await removeSession(session.id);
              });
          }
        },
      );
    },
    [confirms, removeSession, sessions, tabs],
  );

  const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);

  return {
    inTabs,
    openSession,
    openSessionById,
    openFile,
    openFileInBrowser,
    openStub,
    openTerminal,
    openTerminalIn,
    openSignIn,
    openBrowser,
    openProcessRun,
    closeTab,
    closeTabs,
  };
}
