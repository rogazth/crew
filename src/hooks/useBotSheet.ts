import { useCallback, useState } from "react";
import type { BotDraft } from "../chrome/BotPane";
import { MIN_SAVE_MS } from "../lib/timing";
import type { Session } from "../lib/types";
import { setBotFace } from "./useBotFaces";
import type { useSessions } from "./useSessions";

type Sessions = ReturnType<typeof useSessions>;

type Deps = {
  create: Sessions["create"];
  update: Sessions["update"];
  openSession: (session: Session) => void;
};

/** One pane serves both create and edit: a new bot is saved whole, a bot that exists a field at a time. */
export function useBotSheet({ create, update, openSession }: Deps) {
  const [sheet, setSheet] = useState<{ session: Session | null; worktree?: string } | null>(null);

  /** `worktree` is where a new bot is made, from "New bot here" on a worktree; the sheet itself has no picker. */
  const newBot = useCallback(
    (worktree?: string) => setSheet(worktree ? { session: null, worktree } : { session: null }),
    [],
  );
  const editBot = useCallback((session: Session) => setSheet({ session }), []);
  const close = useCallback(() => setSheet(null), []);

  const save = useCallback(
    async (draft: BotDraft) => {
      const editing = sheet?.session;
      // Writing is instant, which reads as cheap; the floor holds the spinner so the
      // sidebar row, the tab and the sheet's exit all land on the same beat.
      const settle = new Promise((r) => setTimeout(r, MIN_SAVE_MS));
      const { face, ...fields } = draft;
      if (editing) {
        await update(editing.id, fields, settle);
        setBotFace(editing.id, face);
        return;
      }
      const session = await create("bot", { ...fields, worktree: sheet?.worktree ?? null }, settle);
      if (!session) return;
      setBotFace(session.id, face);
      openSession(session);
    },
    [create, openSession, sheet, update],
  );

  /** One change to a bot that exists, written at once; the rest of it as it stands. */
  const patch = useCallback(
    async (session: Session, fields: Partial<BotDraft>) => {
      const { face, ...rest } = fields;
      if (face) setBotFace(session.id, face);
      if (Object.keys(rest).length === 0) return;
      const { name, provider, model, description, notifications, autonomy } = session;
      await update(session.id, { name, provider, model, description, notifications, autonomy, ...rest });
    },
    [update],
  );

  return { sheet, newBot, editBot, close, save, patch };
}
