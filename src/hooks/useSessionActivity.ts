import { useCallback, useEffect, useRef } from "react";
import type { Session, SessionStatus } from "../lib/types";

/**
 * The tab indicator speaks for the sessions you are not looking at: output means
 * it is still going, a bell means it wants you, and opening the tab is the
 * acknowledgement that turns either one into a check. A session that has never
 * said anything stays `idle`, which draws nothing at all.
 */
export function useSessionActivity(
  session: Session,
  active: boolean,
  onStatus: (id: string, status: SessionStatus) => void,
) {
  const sent = useRef<SessionStatus>(session.status);

  const push = useCallback(
    (next: SessionStatus) => {
      if (sent.current === next) return;
      sent.current = next;
      onStatus(session.id, next);
    },
    [onStatus, session.id],
  );

  useEffect(() => {
    if (active && sent.current !== "idle") push("done");
  }, [active, push]);

  return {
    onBell: useCallback(() => push(active ? "done" : "needs-input"), [active, push]),
    onActivity: useCallback(() => {
      if (!active) push("working");
    }, [active, push]),
  };
}
