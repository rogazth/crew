import type { DownloadInfo } from "./bridge";

/**
 * This window's downloads, newest first, as main last reported each one.
 * Kept in memory only: the files are on disk, and the list starts empty with
 * the window, the way a browser's download bubble does.
 */
export type DownloadStore = {
  list(): readonly DownloadInfo[];
  /** Replaces the download with the same id in place, or puts a new one first. */
  upsert(info: DownloadInfo): void;
  remove(id: string): void;
  /** Drops every download that is no longer running. */
  clearFinished(): void;
  subscribe(cb: () => void): () => void;
};

const KEPT = 50;

export function isRunning(info: Pick<DownloadInfo, "state">): boolean {
  return info.state === "progressing" || info.state === "paused";
}

export function createDownloadStore(kept = KEPT): DownloadStore {
  let items: readonly DownloadInfo[] = [];
  const listeners = new Set<() => void>();
  const set = (next: readonly DownloadInfo[]) => {
    items = next;
    for (const cb of [...listeners]) cb();
  };
  return {
    list: () => items,
    upsert(info) {
      const at = items.findIndex((item) => item.id === info.id);
      if (at >= 0) {
        const next = [...items];
        next[at] = info;
        set(next);
        return;
      }
      // Past the cap the oldest finished one goes first; a running one is never dropped from view.
      let next = [info, ...items];
      while (next.length > kept) {
        let drop = next.length - 1;
        while (drop >= 0 && isRunning(next[drop] as DownloadInfo)) drop--;
        if (drop < 0) break;
        next = next.filter((_, index) => index !== drop);
      }
      set(next);
    },
    remove(id) {
      if (items.some((item) => item.id === id)) set(items.filter((item) => item.id !== id));
    },
    clearFinished() {
      if (items.some((item) => !isRunning(item))) set(items.filter(isRunning));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export const downloads: DownloadStore = createDownloadStore();

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** 1,536 → "1.5 KB": one decimal under 10 of a unit, none above, like Finder. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** How far along, 0 to 1, or null when the server never said how big it is. */
export function progressOf(info: Pick<DownloadInfo, "received" | "total">): number | null {
  if (info.total <= 0) return null;
  return Math.min(1, Math.max(0, info.received / info.total));
}

/** The line under a download's name. */
export function downloadStatus(info: DownloadInfo): string {
  const size = (bytes: number) => formatBytes(bytes);
  const sofar = info.total > 0 ? `${size(info.received)} of ${size(info.total)}` : size(info.received);
  switch (info.state) {
    case "progressing":
      return sofar;
    case "paused":
      return `Paused · ${sofar}`;
    case "completed":
      return size(info.total > 0 ? info.total : info.received);
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
  }
}

/** The running downloads' combined progress, for the toolbar's ring; null when none knows its size. */
export function overallProgress(list: readonly DownloadInfo[]): number | null {
  const running = list.filter(isRunning);
  if (running.length === 0 || running.some((info) => info.total <= 0)) return null;
  const total = running.reduce((sum, info) => sum + info.total, 0);
  const received = running.reduce((sum, info) => sum + Math.min(info.received, info.total), 0);
  return total > 0 ? received / total : null;
}
