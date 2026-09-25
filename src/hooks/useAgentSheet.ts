import { useCallback, useState } from "react";
import type { AgentDraft } from "../chrome/AgentSheet";
import { MIN_SAVE_MS } from "../lib/timing";
import type { Session } from "../lib/types";
import { setAgentFace } from "./useAgentFaces";
import type { useSessions } from "./useSessions";

type Sessions = ReturnType<typeof useSessions>;

type Deps = {
  create: Sessions["create"];
  update: Sessions["update"];
  openSession: (session: Session) => void;
  /** A new branch asked for in the sheet becomes a worktree before the agent is made in it. */
  createWorktree: (branch: string) => Promise<{ path: string; main: boolean }>;
};

/** One sheet serves both create and edit. The sheet closes itself so its exit can play. */
export function useAgentSheet({ create, update, openSession, createWorktree }: Deps) {
  const [sheet, setSheet] = useState<{ session: Session | null; worktree?: string } | null>(null);

  /** `worktree` preselects where it works: the plus on a worktree's line passes its own. */
  const newAgent = useCallback(
    (worktree?: string) => setSheet(worktree ? { session: null, worktree } : { session: null }),
    [],
  );
  const editAgent = useCallback((session: Session) => setSheet({ session }), []);
  const close = useCallback(() => setSheet(null), []);

  const save = useCallback(
    async (draft: AgentDraft) => {
      const editing = sheet?.session;
      // Writing is instant, which reads as cheap; the floor holds the spinner so the
      // sidebar row, the tab and the sheet's exit all land on the same beat.
      const settle = new Promise((r) => setTimeout(r, MIN_SAVE_MS));
      const { place, face, ...fields } = draft;
      // Where an agent works is chosen once, when it is made.
      if (editing) {
        await update(editing.id, fields, settle);
        setAgentFace(editing.id, face);
        return;
      }
      const tree =
        place.kind === "branch" ? await createWorktree(place.branch) : null;
      const worktree = tree ? (tree.main ? null : tree.path) : place.kind === "worktree" ? place.path : null;
      const session = await create("agent", { ...fields, worktree }, settle);
      if (!session) return;
      setAgentFace(session.id, face);
      openSession(session);
    },
    [create, createWorktree, openSession, sheet, update],
  );

  return { sheet, newAgent, editAgent, close, save };
}
