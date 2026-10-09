import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { DEFAULT_SESSION_VIEW, parseSessionView, SESSION_VIEW_KEY, type SessionView } from "../lib/sessionView";

/**
 * One value for the whole window, outside React's tree: Settings changes it
 * and whatever creates a session reads it, without either holding the other.
 */
let state: SessionView = DEFAULT_SESSION_VIEW;
let loaded = false;
const listeners = new Set<() => void>();

function set(next: SessionView) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function load() {
  if (loaded) return;
  loaded = true;
  api
    .stateGet(SESSION_VIEW_KEY)
    .then((raw) => set(parseSessionView(raw)))
    .catch(() => {
      loaded = false;
    });
}

/** The view new sessions open in. A session keeps the one it was created with, so a change reaches none already open. */
export function useSessionView() {
  useEffect(load, []);
  const view = useSyncExternalStore(subscribe, () => state);

  const update = useCallback((next: SessionView) => {
    set(next);
    void api.stateSet(SESSION_VIEW_KEY, next).catch(() => {});
  }, []);

  return { view, update };
}
