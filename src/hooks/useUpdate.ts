import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { appInfo, updateHost } from "../lib/host";
import type { AppInfo } from "../lib/appInfo";
import { autoDownload, loadAutoDownload, saveAutoDownload, subscribeAutoDownload } from "../lib/updatePrefs";
import type { SettingsSectionId } from "../lib/settings";
import type { ReleaseList, UpdateState } from "../lib/update";

const IDLE: UpdateState = { phase: "idle", checkedAt: null };

/** Follows the updater in main; a window opened mid-update picks up where it is. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>(IDLE);
  useEffect(() => {
    const host = updateHost();
    if (!host) return;
    let heard = false;
    const unlisten = host.onState((next) => {
      heard = true;
      setState(next);
    });
    void host.current().then((next) => {
      if (!heard) setState(next);
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
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void appInfo()
      .then((next) => live && setInfo(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return info;
}

/** The published releases; `null` while loading. A feed that cannot be reached answers from the cache. */
export function useReleases(): { list: ReleaseList | null; reload: () => void } {
  const [list, setList] = useState<ReleaseList | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    const host = updateHost();
    if (!host) return;
    void host
      .releases()
      .then((next) => live && setList(next))
      .catch(() => live && setList({ releases: [], stale: true }));
    return () => {
      live = false;
    };
  }, [tries]);
  return {
    list,
    reload: () => {
      setList(null);
      setTries((n) => n + 1);
    },
  };
}

/** App-level: hands the saved auto-download choice to the updater, and opens About when the menu checks for updates. */
export function useUpdateWiring(openSettings: (section: SettingsSectionId) => void) {
  useEffect(() => void loadAutoDownload(), []);
  useEffect(() => updateHost()?.onShow(() => openSettings("about")), [openSettings]);
}
