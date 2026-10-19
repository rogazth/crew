// "Rename" on a workspace's mark in the rail asks the
// sidebar's header to open its own field: the name is renamed where it is shown.
import { useSyncExternalStore } from "react";

let wanted: string | null = null;
const listeners = new Set<() => void>();

export function requestWorkspaceRename(id: string) {
  wanted = id;
  for (const listener of listeners) listener();
}

/** The workspace whose rename was asked for, until `clear`. */
export function useWorkspaceRenameRequest(): { wanted: string | null; clear: () => void } {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => wanted,
  );
  return { wanted: current, clear: () => (wanted = null) };
}
