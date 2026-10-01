import { useCallback, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { closePrompt, stopPrompt, unsavedCost } from "../lib/confirm";
import { isBusy } from "../lib/terminalBusy";
import type { Session, SessionStatus, Workspace, Worktree } from "../lib/types";
import { commandsCost, isDirtyRefusal, removalCost, worktreeLabel } from "../lib/worktrees";

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
  removeWorktree: (tree: Worktree, force: boolean) => Promise<void>;
  /** Git's list now, when a removal meets work the last listing did not count. */
  rereadWorktrees: () => Promise<Worktree[]>;
};

/** Every destructive prompt of the shell, behind one dialog. */
export function useConfirmations({ closeTabsFor, removeSession, removeWorkspace, removeWorktree, rereadWorktrees }: Deps) {
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

  /** `unsaved` names the files of its tabs whose edits go with them. */
  const askWorkspace = useCallback(
    (workspace: Workspace, unsaved: string[]) =>
      setConfirm({
        title: `Remove workspace "${workspace.name}"?`,
        description: ["Agents and sessions inside it are deleted. Files on disk are untouched.", unsavedCost(unsaved)]
          .filter(Boolean)
          .join(" "),
        action: "Remove",
        onConfirm: () => removeWorkspace(workspace.id),
      }),
    [removeWorkspace],
  );

  /**
   * Git keeps the branch; what goes is the folder, what nobody committed in it,
   * and its sessions. Nothing closes until crewd has removed it. The count comes
   * from the last listing, so git may know of work the prompt did not: crewd
   * refuses, and the prompt asks again with git's count, forced this time.
   * `unsaved` names the files of its tabs whose edits go with them.
   */
  const askWorktree = useCallback(
    (tree: Worktree, sessions: Session[], unsaved: string[], commands: string[] = []) => {
      const prompt = (listed: Worktree, force: boolean): Confirm => ({
        title: `Remove worktree "${worktreeLabel(listed)}"?`,
        description: [removalCost(listed.dirty, sessions.length), commandsCost(commands), unsavedCost(unsaved)]
          .filter(Boolean)
          .join(" "),
        action: "Remove",
        onConfirm: async () => {
          try {
            await removeWorktree(listed, force);
          } catch (error) {
            if (force || !isDirtyRefusal(error)) throw error;
            const fresh = (await rereadWorktrees()).find((entry) => entry.path === listed.path) ?? listed;
            return prompt(fresh, true);
          }
          for (const session of sessions) closeTabsFor(session.id);
        },
      });
      setConfirm(prompt(tree, tree.dirty > 0));
    },
    [closeTabsFor, removeWorktree, rereadWorktrees],
  );

  /**
   * A session's tab closes without a word, whatever runs in it: an agent's
   * turn belongs to the daemon, and a terminal session's CLI runs on in crewd
   * until it is stopped. `unsaved` names the files whose edits the close
   * loses; confirming is what discards them.
   */
  const askCloseTabs = useCallback((unsaved: string[], count: number, onConfirm: () => void) => {
    const prompt = closePrompt(count, unsaved);
    if (prompt) setConfirm({ ...prompt, onConfirm });
    else onConfirm();
  }, []);

  /**
   * Stopping a terminal session ends its CLI. The status cannot say whether
   * that loses work — a watched tab reads idle whatever it runs — so this asks
   * the terminal itself, and asks first only while it is at work.
   */
  const askStop = useCallback((session: Session, onConfirm: () => void) => {
    const label = runningLabel(session.status) ?? (isBusy(session.id) ? "is still working" : null);
    if (label) setConfirm({ ...stopPrompt(session.name, label), onConfirm });
    else onConfirm();
  }, []);

  const close = useCallback(() => setConfirm(null), []);

  return {
    confirm,
    ask: setConfirm,
    askCloseTabs,
    askStop,
    askSession,
    askSessions,
    askWorkspace,
    askWorktree,
    close,
  };
}
