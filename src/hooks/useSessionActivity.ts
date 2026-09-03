import { useCallback, useEffect, useRef } from "react";
import type { Session, SessionStatus } from "../lib/types";

/** Claude's spinner repaints every ~100ms; a gap this long means the turn ended. */
const QUIET_AFTER = 1500;

/**
 * The tab indicator speaks for the sessions you are not looking at: output means
 * it is still going, silence after output means it finished, a bell means it
 * wants you. Opening the tab is the acknowledgement that turns any of those into
 * a check. A session that has never said anything stays `idle`, which draws
 * nothing at all.
 */
export function useSessionActivity(
  session: Session,
  active: boolean,
  onStatus: (id: string, status: SessionStatus) => void,
) {
  const sent = useRef<SessionStatus>(session.status);
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopWaiting = () => {
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = null;
  };

  const push = useCallback(
    (next: SessionStatus) => {
      if (sent.current === next) return;
      sent.current = next;
      onStatus(session.id, next);
    },
    [onStatus, session.id],
  );

  useEffect(() => {
    if (!active) return;
    stopWaiting();
    if (sent.current !== "idle") push("done");
  }, [active, push]);

  useEffect(() => stopWaiting, []);

  return {
    onBell: useCallback(() => {
      stopWaiting();
      push(active ? "done" : "needs-input");
    }, [active, push]),
    onActivity: useCallback(() => {
      if (active) return;
      // A bell already claimed the slot; the redraw that follows it is not new work.
      if (sent.current === "needs-input" || sent.current === "error") return;
      push("working");
      stopWaiting();
      quiet.current = setTimeout(() => {
        quiet.current = null;
        push("done");
      }, QUIET_AFTER);
    }, [active, push]),
    onExit: useCallback(
      (code: number | null) => {
        stopWaiting();
        push(code === 0 || code === null ? "done" : "error");
      },
      [push],
    ),
  };
}
