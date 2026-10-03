import { app, BrowserWindow, ipcMain, Notification } from "electron";
import { BODY_LIMIT, NOTIFY_CHANNELS, type Banner, type BannerResult } from "../src/lib/notify";

/** How long a banner gets to say it showed or failed before it counts as shown. */
const SETTLE_MS = 1500;
/** Banners kept alive for their click; Notification Center holds few more than this anyway. */
const KEEP = 50;

/**
 * Banners on screen. A Notification that is garbage collected takes its click
 * handler with it, so each one is held until it is clicked, closed or replaced.
 */
const live = new Set<Notification>();

/**
 * A banner's click brings the window up on the session it is about. `window`
 * is the app's one window, if it has one; `reopen` makes it when it was closed.
 */
export function registerNotifyIpc(window: () => BrowserWindow | null, reopen: () => void): void {
  ipcMain.handle(NOTIFY_CHANNELS.show, (event, banner: Banner) => show(banner, () => {
    const win = window();
    if (!win || win.isDestroyed()) return reopen();
    reveal(win);
    if (!event.sender.isDestroyed()) event.sender.send(NOTIFY_CHANNELS.click, banner.target ?? null);
  }));
}

function show(banner: Banner, onClick: () => void): Promise<BannerResult> {
  if (!Notification.isSupported()) return Promise.resolve("unsupported");
  const silent = banner.silent === true;
  const note = new Notification({
    title: banner.title,
    body: banner.body.slice(0, BODY_LIMIT),
    silent,
    // macOS plays nothing for a banner with no sound named.
    ...(!silent && process.platform === "darwin" ? { sound: "default" } : {}),
  });
  const release = () => {
    live.delete(note);
    note.removeAllListeners();
  };
  hold(note);
  note.on("click", () => {
    release();
    onClick();
  });
  note.on("close", release);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("shown"), SETTLE_MS);
    note.once("show", () => {
      clearTimeout(timer);
      resolve("shown");
    });
    // The only word macOS gives that notifications are off for this app.
    note.once("failed", () => {
      clearTimeout(timer);
      release();
      resolve("blocked");
    });
    note.show();
  });
}

function hold(note: Notification): void {
  live.add(note);
  if (live.size <= KEEP) return;
  const oldest = live.values().next().value;
  if (oldest) {
    live.delete(oldest);
    oldest.removeAllListeners();
  }
}

/** In front and focused, even from behind another app or the Dock. */
function reveal(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
}
