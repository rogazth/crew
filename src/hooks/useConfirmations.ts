import { useCallback, useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { closePrompt, unsavedCost } from "../lib/confirm";
import type { Session, Workspace, Worktree } from "../lib/types";
import { commandsCost, isDirtyRefusal, removalCost, worktreeLabel } from "../lib/worktrees";

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
        title: `Delete ${session.kind === "bot" ? "bot" : "session"} "${session.name}"?`,
        description: "Removes its history from this workspace. Can’t be undone.",
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
        description: "Removes their history from this workspace. Can’t be undone.",
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
        description: ["Bots and sessions inside it are deleted. Files on disk are untouched.", unsavedCost(unsaved)]
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
        description: [removalCost(listed.dirty, sessions.length, listed.locked), commandsCost(commands), unsavedCost(unsaved)]
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
      setConfirm(prompt(tree, tree.dirty > 0 || tree.locked !== null));
    },
    [closeTabsFor, removeWorktree, rereadWorktrees],
  );

  /**
   * A session's tab closes without a word, whatever runs in it: a bot's
   * turn belongs to the daemon. `unsaved` names the files whose edits the close
   * loses; confirming is what discards them.
   */
  const askCloseTabs = useCallback((unsaved: string[], count: number, onConfirm: () => void) => {
    const prompt = closePrompt(count, unsaved);
    if (prompt) setConfirm({ ...prompt, onConfirm });
    else onConfirm();
  }, []);

  const close = useCallback(() => setConfirm(null), []);

  return {
    confirm,
    ask: setConfirm,
    askCloseTabs,
    askSession,
    askSessions,
    askWorkspace,
    askWorktree,
    close,
  };
}
