import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { DEFAULT_FILE_PREFS, parseFilePrefs, type FilePrefs } from "../lib/filePrefs";

const KEY = "files:prefs";

let prefs = DEFAULT_FILE_PREFS;
let requested = false;
const listeners = new Set<() => void>();

function publish(next: FilePrefs) {
  prefs = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shared by the file index and the settings page, so an edit re-indexes right away. */
export function useFilePrefs() {
  const current = useSyncExternalStore(subscribe, () => prefs);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => publish(parseFilePrefs(raw)))
      .catch(() => {});
  }, []);

  const update = useCallback((next: FilePrefs) => {
    publish(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return { prefs: current, update };
}
