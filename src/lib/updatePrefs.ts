import * as api from "./api";
import { updateHost } from "./host";

export const AUTO_DOWNLOAD_KEY = "updates:auto-download";

let auto = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  auto = next;
  // The updater lives in main, which cannot read the daemon's state: it is told.
  void updateHost()?.setAutoDownload(next);
  for (const listener of listeners) listener();
}

export function autoDownload(): boolean {
  return auto;
}

/** Reads the saved choice and hands it to the updater; a failed read leaves it off and tries again next time. */
export function loadAutoDownload(): Promise<void> {
  loading ??= api
    .stateGet(AUTO_DOWNLOAD_KEY)
    .then((raw) => set(raw === "true"))
    .catch(() => {
      loading = null;
    });
  return loading;
}

export function saveAutoDownload(next: boolean): void {
  // A read still in flight would put back what this replaces.
  loading = Promise.resolve();
  set(next);
  void api.stateSet(AUTO_DOWNLOAD_KEY, String(next)).catch(() => {});
}

export function subscribeAutoDownload(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
