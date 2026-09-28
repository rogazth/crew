import { useEffect, useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { parseSitePermissions, type SitePermissions } from "../lib/browser/permissions";
import { browserHost } from "../lib/host";

const KEY = "browser:site-permissions";

/**
 * What the person decided each site may use, for every workspace's saved
 * pages. The daemon keeps it; main holds a copy to answer pages without
 * asking. An incognito page's decisions never reach here.
 */
let decisions: SitePermissions = {};
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  browserHost()?.setSitePermissions(decisions);
  for (const cb of [...listeners]) cb();
}

/** Read once per window; later calls share the first read. */
export function loadSitePermissions(): Promise<void> {
  loaded ??= api
    .stateGet(KEY)
    .then((raw) => {
      decisions = parseSitePermissions(raw);
      publish();
    })
    .catch(() => publish());
  return loaded;
}

/** Applied once the saved decisions are in, so an answer given during the read is not lost to it. */
export async function changeSitePermissions(change: (current: SitePermissions) => SitePermissions): Promise<void> {
  await loadSitePermissions();
  decisions = change(decisions);
  publish();
  await api.stateSet(KEY, JSON.stringify(decisions)).catch(() => {});
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function useSitePermissions(): SitePermissions {
  useEffect(() => {
    void loadSitePermissions();
  }, []);
  return useSyncExternalStore(subscribe, () => decisions);
}
