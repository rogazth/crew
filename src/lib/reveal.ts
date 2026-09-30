/**
 * Where to take the reader in a file: a search result's match. `line` is
 * one-based and `from`/`to` count UTF-16 units in it, as the daemon sends them.
 */
export type Reveal = { line: number; from: number; to: number };

const pending = new Map<string, Reveal>();
const listeners = new Set<(path: string) => void>();

/**
 * Asked before the tab opens: an editor that mounts for it takes the spot, and
 * one already on screen hears about it.
 */
export function requestReveal(path: string, at: Reveal): void {
  pending.set(path, at);
  for (const listener of listeners) listener(path);
}

/**
 * The spot waiting for `path`. Forgotten a frame later, not now: a remount in
 * the same tick (StrictMode) has to find it too.
 */
export function pendingReveal(path: string): Reveal | undefined {
  const at = pending.get(path);
  if (at) {
    requestAnimationFrame(() => {
      if (pending.get(path) === at) pending.delete(path);
    });
  }
  return at;
}

/** Calls `cb` with the spot each time one is asked for `path`. */
export function onReveal(path: string, cb: (at: Reveal) => void): () => void {
  const listener = (asked: string) => {
    if (asked !== path) return;
    const at = pendingReveal(path);
    if (at) cb(at);
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
