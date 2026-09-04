import { useCallback, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import type { Session, Workspace } from "../lib/types";

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
          for (const session of list) {
            closeTabsFor(session.id);
            await removeSession(session.id);
          }
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

  const close = useCallback(() => setConfirm(null), []);

  return { confirm, ask: setConfirm, askSession, askSessions, askWorkspace, close };
}
