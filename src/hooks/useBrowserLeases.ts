import { useCallback, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { leases } from "../lib/browser/leases";
import { client } from "../lib/client";
import { getLinks, LOCAL, subscribeLinks } from "../lib/client/registry";
import type { BrowserLease, BrowserLeases } from "../lib/protocol";

let watching = false;

/** Started by the first reader and kept for the life of the window: leases outlive every pane. */
function watch() {
  if (watching) return;
  watching = true;
  // Each daemon leases its own workspaces' tabs: a remote's agents drive this Mac's pages too.
  const loadFrom = (env: string) =>
    void api
      .browserLeasesList(env)
      .then((all) => leases.set(all.leases, all.seq, env))
      .catch(() => {});
  const load = () => {
    const envs = new Set([LOCAL]);
    for (const link of getLinks()) if (link.status === "online") envs.add(link.id);
    for (const env of envs) loadFrom(env);
  };
  client.on("browser-leases", (payload, env) => {
    const all = payload as BrowserLeases;
    leases.set(all.leases, all.seq, env ?? LOCAL);
  });
  // A machine that comes online is asked for its list; one that goes away pins nothing.
  const online = new Set<string>();
  subscribeLinks(() => {
    for (const link of getLinks()) {
      if (link.status === "online" && !online.has(link.id)) {
        online.add(link.id);
        loadFrom(link.id);
      } else if (link.status !== "online" && online.delete(link.id)) {
        leases.set([], undefined, link.id);
      }
    }
  });
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
