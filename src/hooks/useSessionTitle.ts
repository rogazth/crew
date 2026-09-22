import { useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { claudeSessionId, transcriptPath } from '../lib/claudeStorage';
import { homeDir } from '../lib/host';
import type { Session } from '../lib/types';
import { isDerivedSessionName } from '../lib/workspaces';

/** Providers name a session on its first turn and may revise it as the work turns. */
const SWEEP_MS = 15_000;

/**
 * Every provider CLI names its own sessions: Claude in its transcript, the
 * others in their own storage once their session id is known. Crew's derived
 * `claude 3` is a placeholder for exactly that name, so it is adopted as soon
 * as it lands. A name the user typed is theirs and stays put; a name Crew
 * adopted is still the provider's to revise, which is what `taken` holds.
 */
export function useSessionTitle(
  sessions: Session[],
  cwd: string | null,
  rename: (id: string, name: string) => Promise<void>,
) {
  const latest = useRef(sessions);
  const taken = useRef(new Map<string, string>());

  // The sweep reads the list as it is when it runs, without restarting on the
  // status patches that rewrite it between turns.
  useEffect(() => {
    latest.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!cwd) return;
    let stopped = false;

    const sweep = async () => {
      const home = await homeDir().catch(() => null);
      if (!home) return;
      for (const session of latest.current) {
        if (stopped) return;
        if (session.kind !== 'terminal') continue;
        const ours =
          isDerivedSessionName(session.name, session.provider) ||
          taken.current.get(session.id) === session.name;
        if (!ours) continue;
        const title = await readTitle(session, home, cwd).catch(() => null);
        if (stopped || !title || title === session.name) continue;
        taken.current.set(session.id, title);
        await rename(session.id, title);
      }
    };

    void sweep();
    const timer = setInterval(() => void sweep(), SWEEP_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [cwd, rename]);
}

function readTitle(session: Session, home: string, cwd: string): Promise<string | null> {
  if (session.provider === 'claude') return api.claudeTitle(transcriptPath(home, cwd, claudeSessionId(session)));
  if (!session.providerSessionId) return Promise.resolve(null);
  return api.providerTitle(session.provider, session.providerSessionId);
}
