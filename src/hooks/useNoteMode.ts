import { useCallback, useEffect, useSyncExternalStore } from "react";

export type NoteMode = "read" | "edit";

/**
 * Whether each open note is being read or edited. A note opens to read, an
 * empty one to write in; the choice holds while the app runs, so a tab that
 * comes back is as it was left.
 */
const modes = new Map<string, NoteMode>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `empty` is null until the note's text has loaded. */
export function useNoteMode(path: string, empty: boolean | null) {
  const mode = useSyncExternalStore(subscribe, () => modes.get(path) ?? (empty ? "edit" : "read"));
  // Settled once the text is known: a note typed into stays in editing as it saves.
  useEffect(() => {
    if (empty !== null && !modes.has(path)) modes.set(path, empty ? "edit" : "read");
  }, [path, empty]);
  const toggle = useCallback(() => {
    modes.set(path, mode === "read" ? "edit" : "read");
    for (const listener of listeners) listener();
  }, [path, mode]);
  return [mode, toggle] as const;
}
