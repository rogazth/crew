import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { updateHost } from "../lib/host";
import type { AppInfo } from "../lib/appInfo";
import { autoDownload, loadAutoDownload, saveAutoDownload, subscribeAutoDownload } from "../lib/updatePrefs";
import type { SettingsSectionId } from "../lib/settings";
import { READS, keep, peek, refresh, useRead } from "../lib/settingsReads";
import type { ReleaseList, UpdateState } from "../lib/update";

const IDLE: UpdateState = { phase: "idle", checkedAt: null };

/** Follows the updater in main; a window opened mid-update picks up where it is. */
export function useUpdateState(): UpdateState {
  // The last state read (Settings reads it ahead), so a surface opens on it rather than on idle.
  const [state, setState] = useState<UpdateState>(() => peek(READS.update) ?? IDLE);
  useEffect(() => {
    const host = updateHost();
    if (!host) return;
    let heard = false;
    const unlisten = host.onState((next) => {
      heard = true;
      keep(READS.update, next);
      setState(next);
    });
    void host.current().then((next) => {
      if (heard) return;
      keep(READS.update, next);
      setState(next);
    });
    return () => {
      heard = true;
      unlisten();
    };
  }, []);
  return state;
}

/** What a surface can ask of the updater. Every call is a no-op outside Electron. */
export function useUpdateActions() {
  return {
    check: useCallback(() => void updateHost()?.check(), []),
    download: useCallback(() => void updateHost()?.download(), []),
    restart: useCallback(() => void updateHost()?.restart(), []),
    skip: useCallback(() => void updateHost()?.dismiss(), []),
    cancel: useCallback(() => void updateHost()?.cancel(), []),
  };
}

/** The "download automatically" choice, persisted; the updater in main is told on every change. */
export function useAutoDownload(): [boolean, (on: boolean) => void] {
  useEffect(() => void loadAutoDownload(), []);
  return [useSyncExternalStore(subscribeAutoDownload, autoDownload), saveAutoDownload];
}

/** The build About describes; null until read, and outside Electron. */
export function useAppInfo(): AppInfo | null {
  return useRead(READS.appInfo) ?? null;
}

/** The published releases; `null` while loading. A feed that cannot be reached answers from the cache. */
export function useReleases(): { list: ReleaseList | null; reload: () => void } {
  const [reloading, setReloading] = useState(false);
  const list = useRead(READS.releases) ?? null;
  return {
    list: reloading ? null : list,
    reload: () => {
      setReloading(true);
      void refresh(READS.releases).finally(() => setReloading(false));
    },
  };
}

/** App-level: hands the saved auto-download choice to the updater, and opens About when the menu checks for updates. */
export function useUpdateWiring(openSettings: (section: SettingsSectionId) => void) {
  useEffect(() => void loadAutoDownload(), []);
  useEffect(() => updateHost()?.onShow(() => openSettings("about")), [openSettings]);
}
