import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { LEGACY_KEYS, legacyPrefs, parsePrefs, type SidebarPrefs } from "../lib/sidebarPrefs";

const KEY = "sidebar:prefs";

/**
 * Three picks of the view menu used to live in this browser's localStorage.
 * The first load folds them into the store and clears them; they stay put if
 * the store does not take them.
 */
async function loadPrefs(): Promise<SidebarPrefs> {
  const stored = parsePrefs(await api.stateGet(KEY));
  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const old = legacyPrefs(read);
  if (Object.keys(old).length === 0) return stored;
  const merged = { ...stored, ...old };
  try {
    await api.stateSet(KEY, JSON.stringify(merged));
    for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key);
  } catch {
    // Not saved: the old keys stay and are folded in again on the next load.
  }
  return merged;
}

/** Null until the store answers, so a non-default grouping never flashes the default one. */
export function useSidebarPrefs() {
  const [prefs, setPrefs] = useState<SidebarPrefs | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPrefs()
      .then((loaded) => !cancelled && setPrefs(loaded))
      .catch(() => !cancelled && setPrefs(parsePrefs(null)));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback((next: SidebarPrefs) => {
    setPrefs(next);
    void api.stateSet(KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  return [prefs, update] as const;
}
