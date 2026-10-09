import { client } from "./client";
import type { SessionLive, SessionLiveReset } from "./protocol";

/**
 * What each session's CLI is doing, as its hooks told the daemon: running a
 * turn, stopped on a question, up and reading keys. The daemon pushes every
 * change; this keeps the latest per session.
 */

type Listener = () => void;

const lives = new Map<string, SessionLive>();
/** When each session's CLI was switched for another: anything heard of it before then was the old one's. */
const switched = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("session-live", (payload) => offer(payload as SessionLive));
  client.on("session-live-reset", (payload) => reset(payload as SessionLiveReset));
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void fetchLive(id);
  });
}

/** Kept unless what is known is newer: a fetch can answer after the event that changed it. */
function offer(live: SessionLive) {
  const known = lives.get(live.sessionId);
  if (known && known.updatedAt > live.updatedAt) return;
  if (live.updatedAt <= (switched.get(live.sessionId) ?? -Infinity)) return;
  set(live);
}

function reset({ sessionId, at }: SessionLiveReset) {
  switched.set(sessionId, at);
  lives.delete(sessionId);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

function set(live: SessionLive) {
  lives.set(live.sessionId, live);
  for (const listener of listeners.get(live.sessionId) ?? []) listener();
}

async function fetchLive(id: string): Promise<void> {
  try {
    const live = await client.request<SessionLive | null>("session_live_get", { id });
    if (live) offer(live);
  } catch {
    // A crewd that predates the hooks being followed has nothing to say.
  }
}

export function subscribeLive(id: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
    void fetchLive(id);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function readLive(id: string): SessionLive | null {
  return lives.get(id) ?? null;
}
