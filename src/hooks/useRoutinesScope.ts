import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";

/**
 * Which routines the Routines page opens on: the active workspace's (`current`), or every workspace's (`all`).
 * What is kept is the choice, not the workspace: narrowing to any one workspace means "the one I am in" next time.
 * One setting for the app, kept across restarts.
 */
export type RoutinesScope = "current" | "all";

const KEY = "routines:scope";

let scope: RoutinesScope = "current";
let requested = false;
const listeners = new Set<() => void>();

function publish(next: RoutinesScope) {
  scope = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRoutinesScope() {
  const current = useSyncExternalStore(subscribe, () => scope);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => (raw === "all" || raw === "current") && publish(raw))
      .catch(() => {});
  }, []);

  const set = useCallback((next: RoutinesScope) => {
    if (next === scope) return;
    publish(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return [current, set] as const;
}
