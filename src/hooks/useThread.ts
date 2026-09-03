import { useEffect, useSyncExternalStore } from "react";
import { load, read, subscribe } from "../lib/transcript";

/** A live view of one session's transcript. The runtime owns it; this only watches. */
export function useThread(sessionId: string) {
  useEffect(() => {
    void load(sessionId);
  }, [sessionId]);
  return useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => read(sessionId),
  );
}
