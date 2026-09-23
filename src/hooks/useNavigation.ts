import { useCallback } from "react";
import * as api from "../lib/api";
import { fileTabId, sessionTabId, stubTabId } from "../lib/tabs";
import { focus as focusBlock } from "../lib/transcript";
import type { ProjectFile, Session, StubKind } from "../lib/types";
import type { useConfirmations } from "./useConfirmations";
import type { useTabs } from "./useTabs";

type Deps = {
  tabs: ReturnType<typeof useTabs>;
  sessions: Session[];
  confirms: ReturnType<typeof useConfirmations>;
  removeSession: (id: string) => Promise<void>;
  closePage: () => void;
};

/**
 * Everything that brings a tab to the front. Pages stack over the tabs, so each
 * of these leaves the page first.
 */
export function useNavigation({ tabs, sessions, confirms, removeSession, closePage }: Deps) {
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
      tabs.open({ id: sessionTabId(session.id), kind: "session", sessionId: session.id });
    },
    [closePage, tabs],
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

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.tabs.find((t) => t.id === id);
      const session =
        tab?.kind === "session" ? sessions.find((s) => s.id === tab.sessionId) : undefined;
      if (!session) {
        tabs.close(id);
        return;
      }
      confirms.askCloseTab(session, async () => {
        if (await api.isSessionDisposable(session.id).catch(() => false)) {
          tabs.closeForSession(session.id);
          await removeSession(session.id);
        } else {
          tabs.close(id);
        }
      });
    },
    [confirms, removeSession, sessions, tabs],
  );

  return { inTabs, openSession, openSessionById, openHit, openFile, openStub, closeTab };
}
