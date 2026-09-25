import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import type { TabScope } from "../lib/worktrees";

const KEY = "tabs:scope";

let scope: TabScope = "worktree";
let requested = false;
const listeners = new Set<() => void>();

function publish(next: TabScope) {
  scope = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tabs per worktree or all together; shared by the shell and the settings page. */
export function useTabScope() {
  const current = useSyncExternalStore(subscribe, () => scope);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => publish(raw === "all" ? "all" : "worktree"))
      .catch(() => {});
  }, []);

  const update = useCallback((next: TabScope) => {
    publish(next);
    void api.stateSet(KEY, next).catch(() => {});
  }, []);

  return { scope: current, update };
}
