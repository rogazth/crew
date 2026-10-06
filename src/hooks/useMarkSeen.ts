import { useEffect, useRef } from "react";
import * as api from "../lib/api";
import { unseen } from "../lib/letters";
import type { Session } from "../lib/types";

/**
 * The session on screen is read up to where it got: a handoff's unread dot,
 * and a failed child's dot on its bot, go once it is opened. The daemon moves
 * the mark and every window hears `session-updated`; one call per position.
 */
export function useMarkSeen(sessions: Session[], visibleId: string | null) {
  const session = visibleId ? sessions.find((row) => row.id === visibleId) : undefined;
  const pending = session && unseen(session) ? `${session.id}:${session.cursor ?? 0}` : null;
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || sent.current === pending) return;
    sent.current = pending;
    const [id, cursor] = pending.split(":");
    void api.markSessionSeen(id!, Number(cursor)).catch(() => {
      sent.current = null;
    });
  }, [pending]);
}
