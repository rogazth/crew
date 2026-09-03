import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { parsePrefs, type SidebarPrefs } from "../lib/sidebarPrefs";

const KEY = "sidebar:prefs";

/** Null until the store answers, so a non-default grouping never flashes the default one. */
export function useSidebarPrefs() {
  const [prefs, setPrefs] = useState<SidebarPrefs | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stateGet(KEY)
      .then((raw) => !cancelled && setPrefs(parsePrefs(raw)))
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
