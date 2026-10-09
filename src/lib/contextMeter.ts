import { useCallback, useSyncExternalStore } from "react";
import { client } from "./client";
import type { ContextReading, TranscriptApply } from "./protocol";

/**
 * How full each session's context window is, for the composer's meter. The
 * daemon puts `context.updated` on the transcript; this keeps the newest per
 * session, and asks once, when a session is first watched, for a reading that
 * came before this window opened.
 */

type Listener = () => void;

const readings = new Map<string, ContextReading>();
/** Bumped by every reading heard: a read that went out before one is older than it. */
const heard = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("transcript-apply", (payload) => {
    const apply = payload as TranscriptApply;
    if (apply.event.type !== "context.updated") return;
    heard.set(apply.sessionId, (heard.get(apply.sessionId) ?? 0) + 1);
    store(apply.sessionId, apply.event);
  });
  client.onReconnect((here = () => true) => {
    for (const id of listeners.keys()) if (here(id)) void fetchReading(id);
  });
}

/** The reading a new one makes: one without a window keeps the last window and auto-compact point. */
export function mergeReading(last: ContextReading | undefined, next: ContextReading): ContextReading {
  const window = next.window ?? last?.window;
  const autoCompactAt = next.window === undefined ? last?.autoCompactAt : next.autoCompactAt;
  return {
    used: next.used,
    ...(window === undefined ? {} : { window }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
  };
}

function store(id: string, reading: ContextReading) {
  readings.set(id, mergeReading(readings.get(id), reading));
  for (const listener of listeners.get(id) ?? []) listener();
}

async function fetchReading(id: string): Promise<void> {
  const before = heard.get(id) ?? 0;
  try {
    const reading = await client.request<ContextReading | null>("session_context", { sessionId: id });
    if (reading && (heard.get(id) ?? 0) === before) store(id, reading);
  } catch {
    // A crewd that predates the meter has no reading to give.
  }
}

export function subscribeContext(id: string, listener: Listener): () => void {
  ensureBridge();
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
    void fetchReading(id);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
}

export function readContext(id: string): ContextReading | null {
  return readings.get(id) ?? null;
}

/** A session's context reading, as the daemon last said; null until it has one. */
export function useContextMeter(sessionId: string | null): ContextReading | null {
  const subscribe = useCallback(
    (listener: Listener) => (sessionId ? subscribeContext(sessionId, listener) : () => {}),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => (sessionId ? readContext(sessionId) : null));
}
