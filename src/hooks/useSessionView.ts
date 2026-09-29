import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import {
  DEFAULT_SESSION_VIEW,
  parseSessionView,
  sessionSurface,
  SESSION_VIEW_KEY,
  type SessionSurface,
  type SessionView,
} from "../lib/sessionView";
import type { Session } from "../lib/types";

type State = {
  view: SessionView;
  /** Sessions whose tab shows its terminal for now, whatever the setting says. Never saved. */
  shown: ReadonlySet<string>;
};

/**
 * One value for the whole window, outside React's tree: App picks its zoom by
 * it and every session tab draws by it, and a change in Settings reaches all
 * of them at once.
 */
let state: State = { view: DEFAULT_SESSION_VIEW, shown: new Set() };
let loaded = false;
const listeners = new Set<() => void>();

function set(next: State) {
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
    .then((raw) => set({ ...state, view: parseSessionView(raw) }))
    .catch(() => {
      loaded = false;
    });
}

/** Sessions open in their terminal or in Crew's chat; "Show terminal" flips one tab. */
export function useSessionView() {
  useEffect(load, []);
  const { view, shown } = useSyncExternalStore(subscribe, () => state);

  // A new setting is a fresh start: no tab stays turned the other way.
  const update = useCallback((next: SessionView) => {
    set({ view: next, shown: new Set() });
    void api.stateSet(SESSION_VIEW_KEY, next).catch(() => {});
  }, []);

  const showTerminal = useCallback((sessionId: string, show: boolean) => {
    if (state.shown.has(sessionId) === show) return;
    const next = new Set(state.shown);
    if (show) next.add(sessionId);
    else next.delete(sessionId);
    set({ ...state, shown: next });
  }, []);

  const surfaceOf = useCallback(
    (session: Pick<Session, "id" | "kind" | "provider">): SessionSurface =>
      sessionSurface(session, shown.has(session.id) ? "terminal" : view),
    [shown, view],
  );

  return { view, update, surfaceOf, showTerminal };
}
