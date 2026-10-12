import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { readBackground, subscribeBackground, tabBackgroundCount } from "../lib/background";
import type { BackgroundList } from "../lib/protocol";
import type { Session } from "../lib/types";

/** A session's background commands, as the daemon last said; null until it has. */
export function useBackground(sessionId: string | null): BackgroundList | null {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeBackground(sessionId, listener) : () => {}),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => (sessionId ? readBackground(sessionId) : null));
}

/** The time, again every `ms` while `enabled`: what a "running 2m" label is drawn against. */
export function useNow(ms: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [enabled, ms]);
  return now;
}

/** How many commands a session's tab counts as still running in the background. */
export function useTabBackground(session: Session | undefined): number {
  const list = useBackground(session?.id ?? null);
  return session ? tabBackgroundCount(session, list) : 0;
}
