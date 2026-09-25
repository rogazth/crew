import { useEffect, useMemo, useRef } from 'react';
import { setBusy } from '../lib/terminalBusy';
import { TerminalActivity } from '../lib/terminalStatus';
import type { Session, SessionStatus } from '../lib/types';

/**
 * The tab indicator for a terminal session, read off what its process does:
 * working while the CLI is busy, unread once it finished out of sight, a bell
 * when it wants you. Opening the tab reads it.
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
  const id = session.id;
  const activity = useRef<TerminalActivity | null>(null);
  const latest = useRef({ onStatus, status: session.status, active });
  useEffect(() => {
    latest.current = { onStatus, status: session.status, active };
  });

  useEffect(() => {
    const { status, active: watched } = latest.current;
    const tracker = new TerminalActivity(status, watched, {
      report: (next) => latest.current.onStatus(id, next),
      onBusy: (busy) => setBusy(id, busy),
    });
    activity.current = tracker;
    return () => {
      tracker.dispose();
      if (activity.current === tracker) activity.current = null;
    };
  }, [id]);

  useEffect(() => {
    activity.current?.setWatched(active);
  }, [active]);

  return useMemo(
    () => ({
      onBell: () => activity.current?.bell(),
      onActivity: () => activity.current?.output(),
      onTitle: (title: string) => activity.current?.title(title),
      onInput: () => activity.current?.input(),
      onResize: () => activity.current?.settle(),
      onExit: (code: number | null) => activity.current?.exit(code),
    }),
    [],
  );
}
