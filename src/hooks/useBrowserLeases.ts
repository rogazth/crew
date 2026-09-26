import { useCallback, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { leases } from "../lib/browser/leases";
import { client } from "../lib/client";
import type { BrowserLease, BrowserLeases } from "../lib/protocol";

let watching = false;

/** Started by the first reader and kept for the life of the window: leases outlive every pane. */
function watch() {
  if (watching) return;
  watching = true;
  const load = () =>
    void api
      .browserLeasesList()
      .then((all) => leases.set(all.leases))
      .catch(() => {});
  client.on("browser-leases", (payload) => leases.set((payload as BrowserLeases).leases));
  // A daemon that restarted holds no leases; the list says so.
  client.onReconnect(load);
  load();
}

const subscribe = (cb: () => void) => {
  watch();
  return leases.subscribe(cb);
};

/** Every tab an agent is driving, or is about to. */
export function useHeldTabs(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, leases.held);
}

/** Who drives this tab, if anyone. */
export function useLease(tab: string): BrowserLease | null {
  const read = useCallback(() => leases.get(tab), [tab]);
  return useSyncExternalStore(subscribe, read);
}
