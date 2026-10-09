import { useCallback, useSyncExternalStore } from "react";
import type { CommandCatalog } from "../lib/protocol";
import { readCommands, subscribeCommands } from "../lib/slashCommands";

/** A session's `/` menu, as the daemon last said; null until it has. */
export function useCommands(sessionId: string | null): CommandCatalog | null {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeCommands(sessionId, listener) : () => {}),
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => (sessionId ? readCommands(sessionId) : null));
}
