import { useCallback } from "react";
import * as api from "../lib/api";
import { paneHandle } from "../lib/browser/handles";
import { fileTabId, newBrowserTab, sessionTabId, stubTabId } from "../lib/tabs";
import { focus as focusBlock } from "../lib/transcript";
import { discardEdits, fileName, unsavedTabs } from "../lib/unsavedEdits";
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
   * Where a session's tab belongs when that is not the strip on screen: its
   * worktree is made current, and the tab goes to that worktree's strip.
   */
  route: (session: Session) => { context: string | null } | null;
};

/**
 * Everything that brings a tab to the front. Pages stack over the tabs, so each
 * of these leaves the page first.
 */
export function useNavigation({ tabs, sessions, confirms, removeSession, closePage, route }: Deps) {
  /** Wraps a tab action so it lands in view instead of behind whatever page is up. */
  const inTabs = useCallback(
    (act: () => void) => () => {
      closePage();
      act();
    },
    [closePage],
  );

  const openSession = useCallback(
    (session: Session) => {
      closePage();
      const tab = { id: sessionTabId(session.id), kind: "session" as const, sessionId: session.id };
      const elsewhere = route(session);
      if (elsewhere?.context) tabs.openIn(elsewhere.context, tab);
      else tabs.open(tab);
    },
    [closePage, route, tabs],
  );

  /** A message from another agent names its sender; the name opens its tab. */
  const openSessionById = useCallback(
    (id: string) => {
      const found = sessions.find((session) => session.id === id);
      if (found) openSession(found);
    },
    [sessions, openSession],
  );

  /** A search hit: open the agent, then take the reader to the line. */
  const openHit = useCallback(
    (id: string, pos: number) => {
      openSessionById(id);
      void focusBlock(id, pos);
    },
    [openSessionById],
  );

  const openFile = useCallback(
    (file: ProjectFile) => {
      closePage();
      tabs.open({ id: fileTabId(file.path), kind: "file", path: file.path, relative: file.relative });
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

  /** Every call is a new tab: pages have no natural key to dedupe on. */
  const openBrowser = useCallback(
    (url = "") => {
      closePage();
      tabs.open(newBrowserTab(url));
    },
    [closePage, tabs],
  );

  /** A URL from outside a page: the browser tab underneath takes it, else a new one does. */
  const openUrl = useCallback(
    (url: string) => {
      closePage();
      const handle = tabs.active?.kind === "browser" ? paneHandle(tabs.active.id) : undefined;
      if (handle) handle.navigate(url);
      else tabs.open(newBrowserTab(url));
    },
    [closePage, tabs],
  );

  /**
   * A session tab that never held a turn goes with its session; any other
   * leaves the session in the sidebar. Running terminals and files with
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
        [...owned.values()],
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

  return { inTabs, openSession, openSessionById, openHit, openFile, openStub, openBrowser, openUrl, closeTab, closeTabs };
}
