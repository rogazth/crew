import { useEffect, useRef } from 'react';
import * as api from '../lib/api';
import type { Session } from '../lib/types';

/** Providers name a session on its first turn and may revise it as the work turns. */
const SWEEP_MS = 15_000;

/**
 * Every provider CLI names its own sessions. The daemon compares what the
 * provider holds with the title it saw last and adopts each new one, so this
 * only asks and catches the list up.
 */
export function useSessionTitle(sessions: Session[], adopt: (id: string, name: string) => void) {
  const latest = useRef(sessions);

  // The sweep reads the list as it is when it runs, without restarting on the
  // status patches that rewrite it between turns.
  useEffect(() => {
    latest.current = sessions;
  }, [sessions]);

  useEffect(() => {
    let stopped = false;
    const sweep = () =>
      Promise.all(
        latest.current.map(async (session) => {
          if (session.kind !== 'terminal') return;
          const name = await api.syncSessionTitle(session.id).catch(() => null);
          if (!stopped && name) adopt(session.id, name);
        }),
      );
    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [adopt]);
}
