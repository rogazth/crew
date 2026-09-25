import { useCallback, useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";

const KEY = "markdown:outline";

let open = true;
let requested = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  open = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether notes show their outline. One setting for every note, kept across restarts. */
export function useOutlinePref() {
  const current = useSyncExternalStore(subscribe, () => open);

  useEffect(() => {
    if (requested) return;
    requested = true;
    api
      .stateGet(KEY)
      .then((raw) => raw !== null && publish(raw === "true"))
      .catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    publish(!open);
    void api.stateSet(KEY, String(open)).catch(() => {});
  }, []);

  return [current, toggle] as const;
}
