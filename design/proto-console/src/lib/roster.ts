import { useMemo } from "react";
import {
  mailbox,
  rosterFrom,
  threads as demoThreads,
  type Block,
  type Letter,
  type Roster,
  type Session,
} from "@crew/fixtures";
import { store, useApp } from "./store";
import { threadOf } from "./source";

/** Turns an agent id into its display name — what `toolLine` needs to read well. */
export function resolveAgent(id: string): string {
  return store.session(id)?.name ?? id;
}

/**
 * A letter exists in two transcripts, so the roster has to see both — including
 * the one nobody has opened. The base is whatever the fixtures hold; any thread
 * that *is* open overlays it, so a letter delivered this second counts.
 *
 * Only open threads are read: building four hundred of them to count two
 * envelopes would be the most expensive thing in the window.
 */
export function rosterNow(sessions: Session[]): Roster {
  const threads: Record<string, Block[]> = { ...demoThreads };
  for (const session of sessions) {
    if (session.kind !== "agent") continue;
    const held = openThread(session.id);
    if (held) threads[session.id] = held;
  }
  return rosterFrom(sessions, threads);
}

const open = new Map<string, Block[]>();

/** Chat calls this on every thread update so the roster can stay current. */
export function noteThread(sessionId: string, blocks: Block[]): void {
  open.set(sessionId, blocks);
}

const openThread = (sessionId: string): Block[] | undefined => open.get(sessionId);

export { threadOf };

/**
 * The daemon has always tracked what is queued for a busy agent; the UI has
 * never shown it. This is the number behind "2 queued".
 */
export function useMailbox(sessionId: string): Letter[] {
  const state = useApp();
  return useMemo(
    () => (sessionId ? mailbox(rosterNow(state.sessions), sessionId) : []),
    // The roster is rebuilt from open threads, so any store change may move it.
    [state.sessions, state.epoch, sessionId],
  );
}
