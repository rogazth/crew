import { useCallback, useEffect, useRef } from 'react';
import { setBusy } from '../lib/terminalBusy';
import type { Session, SessionStatus } from '../lib/types';

/** Claude's spinner repaints every ~100ms; a gap this long means the turn ended. */
const QUIET_AFTER = 1500;

/**
 * The tab indicator speaks for the sessions you are not looking at: output means
 * it is still going, silence after output means it finished, a bell means it
 * wants you. Opening the tab reads it, which clears the indicator back to `idle`.
 *
 * Whether the terminal is *running* something is tracked either way, watched or
 * not: closing the tab ends the process, and that prompt cannot depend on which
 * tab happened to be in front.
 */
export function useSessionActivity(
  session: Session,
  active: boolean,
  onStatus: (id: string, status: SessionStatus) => void,
) {
  const sent = useRef<SessionStatus>(session.status);
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read when the quiet timer fires, not when it was set: the tab may have come
  // to the front in between, and a tab you are watching shows no indicator.
  const watched = useRef(active);

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
    watched.current = active;
    if (active) push('idle');
  }, [active, push]);

  const id = session.id;
  useEffect(
    () => () => {
      stopWaiting();
      setBusy(id, false);
    },
    [id],
  );

  /** A bell already claimed the slot; the redraw that follows it is not new work. */
  const claimed = () => sent.current === 'needs-input' || sent.current === 'error';

  return {
    onBell: useCallback(() => {
      // Waiting on you is still running: the process is alive behind the prompt.
      stopWaiting();
      setBusy(id, true);
      push(watched.current ? 'idle' : 'needs-input');
    }, [id, push]),
    onActivity: useCallback(() => {
      setBusy(id, true);
      if (!watched.current && !claimed()) push('working');
      stopWaiting();
      quiet.current = setTimeout(() => {
        quiet.current = null;
        setBusy(id, false);
        if (!watched.current && !claimed()) push('done');
      }, QUIET_AFTER);
    }, [id, push]),
    onExit: useCallback(
      (code: number | null) => {
        stopWaiting();
        setBusy(id, false);
        if (code !== 0 && code !== null) push('error');
        else push(watched.current ? 'idle' : 'done');
      },
      [id, push],
    ),
  };
}
