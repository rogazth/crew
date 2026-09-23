import { useCallback, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { isBusy } from "../lib/terminalBusy";
import type { Session, SessionStatus, Workspace } from "../lib/types";

const RUNNING: Record<string, string> = {
  working: "is still working",
  "needs-input": "is waiting on you",
};

export function runningLabel(status: SessionStatus): string | null {
  return RUNNING[status] ?? null;
}

type Deps = {
  /** A deleted session must lose its tabs before the row goes. */
  closeTabsFor: (sessionId: string) => void;
  removeSession: (id: string) => Promise<void>;
  removeWorkspace: (id: string) => void | Promise<void>;
};

/** Every destructive prompt of the shell, behind one dialog. */
export function useConfirmations({ closeTabsFor, removeSession, removeWorkspace }: Deps) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const askSession = useCallback(
    (session: Session) =>
      setConfirm({
        title: `Delete ${session.kind === "agent" ? "agent" : "session"} "${session.name}"?`,
        description: "Its history is removed from this workspace. This cannot be undone.",
        action: "Delete",
        onConfirm: async () => {
          closeTabsFor(session.id);
          await removeSession(session.id);
        },
      }),
    [closeTabsFor, removeSession],
  );

  const askSessions = useCallback(
    (list: Session[]) => {
      const [only] = list;
      if (list.length === 1 && only) return askSession(only);
      setConfirm({
        title: `Delete ${list.length} items?`,
        description: "Their history is removed from this workspace. This cannot be undone.",
        action: "Delete",
        onConfirm: async () => {
          for (const session of list) closeTabsFor(session.id);
          await Promise.all(list.map((session) => removeSession(session.id)));
        },
      });
    },
    [askSession, closeTabsFor, removeSession],
  );

  const askWorkspace = useCallback(
    (workspace: Workspace) =>
      setConfirm({
        title: `Remove workspace "${workspace.name}"?`,
        description: "Agents and sessions inside it are deleted. Files on disk are untouched.",
        action: "Remove",
        onConfirm: () => removeWorkspace(workspace.id),
      }),
    [removeWorkspace],
  );

  /**
   * An agent turn belongs to the daemon, so its tab closes without a word and
   * the turn runs on. A terminal *is* its process: closing the tab ends it, and
   * the status cannot answer that — a watched tab reads idle whatever it runs —
   * so this asks the terminal itself.
   */
  const askCloseTab = useCallback((session: Session, onConfirm: () => void) => {
    const label =
      session.kind === "terminal"
        ? (runningLabel(session.status) ?? (isBusy(session.id) ? "is still working" : null))
        : null;
    if (!label) {
      onConfirm();
      return;
    }
    setConfirm({
      title: `Close "${session.name}"?`,
      description: `It ${label}. Closing the tab ends the process; the session stays in the sidebar.`,
      action: "Close",
      onConfirm,
    });
  }, []);

  const close = useCallback(() => setConfirm(null), []);

  return {
    confirm,
    ask: setConfirm,
    askCloseTab,
    askSession,
    askSessions,
    askWorkspace,
    close,
  };
}
