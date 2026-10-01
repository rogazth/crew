import { client } from "./client";
import type { SessionLive } from "./protocol";

/**
 * What each session's CLI is doing, as its hooks told the daemon: running a
 * turn, stopped on a question, up and reading keys. The daemon pushes every
 * change; this keeps the latest per session.
 */

type Listener = () => void;

const lives = new Map<string, SessionLive>();
/** Sessions on a machine whose crewd predates the hooks being followed. */
const unheard = new Set<string>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("session-live", (payload) => offer(payload as SessionLive));
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void fetchLive(id);
  });
}

/** Kept unless what is known is newer: a fetch can answer after the event that changed it. */
function offer(live: SessionLive) {
  const known = lives.get(live.sessionId);
  if (known && known.updatedAt > live.updatedAt) return;
  set(live);
}

function set(live: SessionLive) {
  lives.set(live.sessionId, live);
  for (const listener of listeners.get(live.sessionId) ?? []) listener();
}

async function fetchLive(id: string): Promise<void> {
  try {
    const live = await client.request<SessionLive | null>("session_live_get", { id });
    if (live) offer(live);
  } catch (error) {
    if (!isUnknownMethod(error)) return;
    unheard.add(id);
    for (const listener of listeners.get(id) ?? []) listener();
  }
}

/** What an older crewd answers a call it does not have. */
export function isUnknownMethod(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).startsWith("Unknown method");
}

/** False when the session's machine runs a crewd that does not follow hooks: it reads as a CLI without them. */
export function liveHeard(id: string): boolean {
  return !unheard.has(id);
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

/** The chat answered an ask with keys: it leaves the screen before any hook says so. */
export function answeredAsk(id: string, askId: number): void {
  void client.request("session_live_answered", { id, askId }).catch(() => {});
}

/** The chat stopped the turn with Esc; Claude says so neither in a hook nor, always, in its history. */
export function stoppedTurn(id: string): void {
  void client.request("session_live_stopped", { id }).catch(() => {});
}
