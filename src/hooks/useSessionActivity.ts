import { useEffect, useMemo, useRef } from 'react';
import { announceSession, announceStatus } from '../lib/notifications';
import { setBusy } from '../lib/terminalBusy';
import { TerminalActivity } from '../lib/terminalStatus';
import type { Session, SessionStatus } from '../lib/types';

/**
 * The tab indicator for a terminal session, read off what its process does:
 * working while the CLI is busy, unread once it finished out of sight, a bell
 * when it wants you. Opening the tab reads it. A turn that ends or stops to
 * ask out of sight, and every bell, is a notification as well.
 *
 * Whether the terminal is *running* something is tracked either way, watched or
 * not: stopping it asks first, and that prompt cannot depend on which tab
 * happened to be in front. `running`: the CLI is up already, its tab closed.
 */
export function useSessionActivity(
  session: Session,
  active: boolean,
  onStatus: (id: string, status: SessionStatus) => void,
  running = false,
) {
  const id = session.id;
  const activity = useRef<TerminalActivity | null>(null);
  const latest = useRef({ onStatus, session, status: session.status, active, running });
  useEffect(() => {
    latest.current = { onStatus, session, status: session.status, active, running };
  });

  useEffect(() => {
    const { status, active: watched, running } = latest.current;
    const tracker = new TerminalActivity(status, watched, {
      report: (next) => {
        latest.current.onStatus(id, next);
        announceStatus(latest.current.session, next);
      },
      onBusy: (busy) => setBusy(id, busy),
      running,
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

  // Its row marks it read without the tab: the tracker learns it is no longer unread.
  useEffect(() => {
    if (session.status === "idle") activity.current?.read();
  }, [session.status]);

  return useMemo(
    () => ({
      onBell: (message?: string) => {
        announceSession(latest.current.session, 'bell', message ?? 'Wants your attention');
        activity.current?.bell();
      },
      onActivity: () => activity.current?.output(),
      onTitle: (title: string) => activity.current?.title(title),
      onInput: () => activity.current?.input(),
      onResize: () => activity.current?.settle(),
      onExit: (code: number | null) => activity.current?.exit(code),
      onLive: (working: boolean, asking: boolean, background: boolean) =>
        activity.current?.hooked(working, asking, background),
    }),
    [],
  );
}
