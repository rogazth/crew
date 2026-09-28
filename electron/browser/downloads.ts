import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, Notification, shell, type DownloadItem, type WebContents } from "electron";
import { CHANNELS, type DownloadAction, type DownloadInfo, type DownloadState } from "../../src/lib/browser/bridge";

/**
 * Every download a page starts, reported to the window that shows the page:
 * where it is, how far along, and what it was saved as. Files go to
 * ~/Downloads under a name nothing there has, unless the person asked to be
 * asked, or chose "Save As…".
 */

/** How often one download reports its progress, at most. */
const PROGRESS_MS = 250;
/** Finished downloads kept for the window's list, oldest dropped first. */
const KEPT = 100;
/** A "Save As…" waits this long for the download it asked for. */
const SAVE_AS_MS = 30_000;

type Entry = { host: WebContents; info: DownloadInfo; item: DownloadItem | null };

const entries = new Map<string, Entry>();
/** URLs the context menu asked to save with a dialog, by when that stops applying. */
const saveAs = new Map<string, number>();
let askWhere = false;

export function setAskWhereToSave(ask: boolean): void {
  askWhere = ask;
}

/** The next download of `url` opens a save dialog, whatever the setting says. */
export function saveNextAs(url: string): void {
  const now = Date.now();
  for (const [key, until] of saveAs) if (until < now) saveAs.delete(key);
  saveAs.set(url, now + SAVE_AS_MS);
}

function takeSaveAs(url: string): boolean {
  const until = saveAs.get(url);
  saveAs.delete(url);
  return until !== undefined && until >= Date.now();
}

/** `name` in `dir`, or "name (1).ext" and up when it is taken. */
export function uniquePath(dir: string, name: string, exists: (file: string) => boolean = existsSync): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; exists(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/** What a download item says about itself, in the window's terms. */
export function stateOf(item: Pick<DownloadItem, "getState" | "isPaused">): DownloadState {
  const state = item.getState();
  if (state === "progressing" && item.isPaused()) return "paused";
  return state;
}

function send(entry: Entry): void {
  if (!entry.host.isDestroyed()) entry.host.send(CHANNELS.downloads, entry.info);
}

function refresh(entry: Entry, item: DownloadItem): void {
  const saved = item.getSavePath();
  entry.info = {
    ...entry.info,
    path: saved,
    filename: saved ? path.basename(saved) : entry.info.filename,
    received: item.getReceivedBytes(),
    total: item.getTotalBytes(),
    state: stateOf(item),
  };
}

function prune(): void {
  if (entries.size <= KEPT) return;
  for (const [id, entry] of entries) {
    if (entries.size <= KEPT) return;
    if (entry.item === null) entries.delete(id);
  }
}

/** Where a download's page is shown: the window, and the page it counts against. */
export type DownloadOwner = { host: WebContents; pageId: number | null };

/**
 * Takes over one download: picks where it goes, then reports it to `owner`
 * until it ends. A download no window's page started still lands on disk;
 * it just shows in no list.
 */
export function trackDownload(item: DownloadItem, owner: DownloadOwner | null): void {
  const name = path.basename(item.getFilename()) || "download";
  const target = uniquePath(app.getPath("downloads"), name);
  // Electron shows the save dialog itself when no path is set before this handler returns.
  if (askWhere || takeSaveAs(item.getURL())) item.setSaveDialogOptions({ defaultPath: target });
  else item.setSavePath(target);
  if (!owner) return;

  const entry: Entry = {
    host: owner.host,
    item,
    info: {
      id: randomUUID(),
      webContentsId: owner.pageId,
      filename: name,
      url: item.getURL(),
      path: askWhere ? "" : target,
      received: 0,
      total: item.getTotalBytes(),
      state: "progressing",
      startedAt: Date.now(),
    },
  };
  entries.set(entry.info.id, entry);
  prune();
  send(entry);

  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  item.on("updated", () => {
    const wait = PROGRESS_MS - (Date.now() - last);
    if (timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        last = Date.now();
        if (entry.item !== item) return;
        refresh(entry, item);
        send(entry);
      },
      Math.max(0, wait),
    );
  });
  item.once("done", (_event, state) => {
    clearTimeout(timer);
    refresh(entry, item);
    entry.item = null;
    send(entry);
    if (state === "completed") announce(entry);
  });
}

/** A finished download says so on the desktop only while the person is looking elsewhere. */
function announce(entry: Entry): void {
  const win = entry.host.isDestroyed() ? null : BrowserWindow.fromWebContents(entry.host);
  if (win?.isFocused() || !Notification.isSupported()) return;
  const file = entry.info.path;
  const note = new Notification({ title: "Download complete", body: entry.info.filename });
  note.on("click", () => shell.showItemInFolder(file));
  note.show();
}

/** Only the window a download was reported to can act on it. */
export async function downloadAction(sender: WebContents, id: unknown, action: unknown): Promise<string> {
  if (typeof id !== "string") return "";
  const entry = entries.get(id);
  if (!entry || entry.host !== sender) return "";
  const { item, info } = entry;
  switch (action as DownloadAction) {
    case "cancel":
      item?.cancel();
      return "";
    case "resume":
      if (item?.canResume()) item.resume();
      return "";
    case "open":
      if (info.state !== "completed" || !existsSync(info.path)) return "The file is no longer there.";
      return shell.openPath(info.path);
    case "reveal":
      if (!info.path || !existsSync(info.path)) return "The file is no longer there.";
      shell.showItemInFolder(info.path);
      return "";
    default:
      return "";
  }
}

/** A closed window's downloads keep going; only the list forgets them. */
export function forgetHost(host: WebContents): void {
  for (const [id, entry] of entries) if (entry.host === host && entry.item === null) entries.delete(id);
}
