import { useCallback, useEffect, useSyncExternalStore } from "react";
import { clearFocus, load, loadEarlier, read, subscribe } from "../lib/transcript";

/** A live view of one session's transcript. The runtime owns it; this only watches. */
export function useThread(sessionId: string) {
  useEffect(() => {
    void load(sessionId);
  }, [sessionId]);
  const thread = useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => read(sessionId),
  );
  const earlier = useCallback(() => void loadEarlier(sessionId), [sessionId]);
  const seen = useCallback(() => clearFocus(sessionId), [sessionId]);
  return { ...thread, loadEarlier: earlier, onFocused: seen };
}
