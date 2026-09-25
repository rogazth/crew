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

/**
 * What rearranges the tab strips for a new scope, set by the shell. It calls
 * `commit` once they are rearranged, so the new scope never shows the old strips.
 */
type Regroup = (to: TabScope, commit: () => void) => Promise<void>;
let regroup: Regroup | null = null;

export function useTabRegroup(handler: Regroup) {
  useEffect(() => {
    regroup = handler;
    return () => {
      if (regroup === handler) regroup = null;
    };
  }, [handler]);
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
    const from = scope;
    if (next === from) return;
    const commit = () => {
      if (scope !== from) return;
      publish(next);
      void api.stateSet(KEY, next).catch(() => {});
    };
    if (!regroup) return commit();
    void regroup(next, commit)
      .catch(() => {})
      .finally(commit);
  }, []);

  return { scope: current, update };
}
