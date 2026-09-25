import { useEffect, useRef } from 'react';
import * as api from '../lib/api';
import type { Session } from '../lib/types';

/** Providers name a session on its first turn and may revise it as the work turns. */
const SWEEP_MS = 15_000;
/** The CLI retitles its terminal as it writes the name down; this reads it after. */
const NUDGE_MS = 800;

const nudges = new Set<(id: string) => void>();

/**
 * A CLI put a new name on its terminal. Claude, opencode and cursor-agent all
 * title it after the session, so the provider most likely renamed it just now.
 */
export function nudgeTitle(id: string): void {
  for (const nudge of nudges) nudge(id);
}

/**
 * Every provider CLI names its own sessions. The daemon compares what the
 * provider holds with the title it saw last and adopts each new one, so this
 * only asks and catches the list up: at once when a terminal's title moves,
 * and on a sweep for whatever changed without a word.
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
    const sync = async (id: string) => {
      const name = await api.syncSessionTitle(id).catch(() => null);
      if (!stopped && name) adopt(id, name);
    };
    const sweep = () =>
      Promise.all(latest.current.map((session) => (session.kind === 'terminal' ? sync(session.id) : null)));
    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_MS);

    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    const nudge = (id: string) => {
      clearTimeout(waiting.get(id));
      waiting.set(
        id,
        setTimeout(() => {
          waiting.delete(id);
          void sync(id);
        }, NUDGE_MS),
      );
    };
    nudges.add(nudge);
    return () => {
      stopped = true;
      clearInterval(timer);
      nudges.delete(nudge);
      for (const pending of waiting.values()) clearTimeout(pending);
    };
  }, [adopt]);
}
