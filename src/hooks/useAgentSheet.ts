import { useCallback, useState } from "react";
import type { AgentDraft } from "../chrome/AgentSheet";
import { MIN_SAVE_MS } from "../lib/timing";
import type { Session } from "../lib/types";
import type { useSessions } from "./useSessions";

type Sessions = ReturnType<typeof useSessions>;

type Deps = {
  create: Sessions["create"];
  update: Sessions["update"];
  openSession: (session: Session) => void;
};

/** One sheet serves both create and edit. The sheet closes itself so its exit can play. */
export function useAgentSheet({ create, update, openSession }: Deps) {
  const [sheet, setSheet] = useState<{ session: Session | null } | null>(null);

  const newAgent = useCallback(() => setSheet({ session: null }), []);
  const editAgent = useCallback((session: Session) => setSheet({ session }), []);
  const close = useCallback(() => setSheet(null), []);

  const save = useCallback(
    async (draft: AgentDraft) => {
      const editing = sheet?.session;
      // Writing is instant, which reads as cheap; the floor holds the spinner so the
      // sidebar row, the tab and the sheet's exit all land on the same beat.
      const settle = new Promise((r) => setTimeout(r, MIN_SAVE_MS));
      if (editing) {
        await update(editing.id, draft, settle);
        return;
      }
      const session = await create("agent", draft, settle);
      if (session) openSession(session);
    },
    [create, openSession, sheet, update],
  );

  return { sheet, newAgent, editAgent, close, save };
}
