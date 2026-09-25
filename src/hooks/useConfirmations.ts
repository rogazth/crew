import { useCallback, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { isBusy } from "../lib/terminalBusy";
import type { Session, SessionStatus, Workspace, Worktree } from "../lib/types";
import { worktreeLabel } from "../lib/worktrees";

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
  removeWorktree: (tree: Worktree, force: boolean) => void | Promise<void>;
};

/** Every destructive prompt of the shell, behind one dialog. */
export function useConfirmations({ closeTabsFor, removeSession, removeWorkspace, removeWorktree }: Deps) {
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

  /** Git keeps the branch; what goes is the folder, what nobody committed in it, and its sessions. */
  const askWorktree = useCallback(
    (tree: Worktree, sessions: Session[]) =>
      setConfirm({
        title: `Remove worktree "${worktreeLabel(tree)}"?`,
        description: [
          tree.dirty > 0
            ? `${tree.dirty} uncommitted ${tree.dirty === 1 ? "change is" : "changes are"} lost with the folder.`
            : "The folder is deleted; the branch stays.",
          sessions.length > 0
            ? `${sessions.length} ${sessions.length === 1 ? "session ends" : "sessions end"} with it.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        action: "Remove",
        onConfirm: async () => {
          for (const session of sessions) closeTabsFor(session.id);
          await removeWorktree(tree, tree.dirty > 0);
        },
      }),
    [closeTabsFor, removeWorktree],
  );

  /**
   * An agent turn belongs to the daemon, so its tab closes without a word and
   * the turn runs on. A terminal *is* its process: closing the tab ends it, and
   * the status cannot answer that — a watched tab reads idle whatever it runs —
   * so this asks the terminal itself.
   */
  const askCloseTabs = useCallback((sessions: Session[], count: number, onConfirm: () => void) => {
    const running = sessions.flatMap((session) => {
      if (session.kind !== "terminal") return [];
      const label = runningLabel(session.status) ?? (isBusy(session.id) ? "is still working" : null);
      return label ? [{ session, label }] : [];
    });
    const [only] = running;
    if (!only) {
      onConfirm();
      return;
    }
    if (count === 1 && running.length === 1) {
      setConfirm({
        title: `Close "${only.session.name}"?`,
        description: `It ${only.label}. Closing the tab ends the process; the session stays in the sidebar.`,
        action: "Close",
        onConfirm,
      });
      return;
    }
    setConfirm({
      title: `Close ${count} tabs?`,
      description: `${running.length === 1 ? `"${only.session.name}" is` : `${running.length} sessions are`} still running. Closing ends ${running.length === 1 ? "its process" : "their processes"}; the sessions stay in the sidebar.`,
      action: "Close",
      onConfirm,
    });
  }, []);

  const askCloseTab = useCallback(
    (session: Session, onConfirm: () => void) => askCloseTabs([session], 1, onConfirm),
    [askCloseTabs],
  );

  const close = useCallback(() => setConfirm(null), []);

  return {
    confirm,
    ask: setConfirm,
    askCloseTab,
    askCloseTabs,
    askSession,
    askSessions,
    askWorkspace,
    askWorktree,
    close,
  };
}
