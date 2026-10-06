import { readFile, stat } from "node:fs/promises";
import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import {
  BODY_LIMIT,
  isSoundFile,
  NOTIFY_CHANNELS,
  SOUND_LIMIT,
  type Banner,
  type BannerResult,
  type BannerState,
  type DockBadge,
} from "../src/lib/notify";

/** How long a banner gets to say it showed or failed before it counts as shown. */
const SETTLE_MS = 1500;
/** Banners kept alive for their click; Notification Center holds few more than this anyway. */
const KEEP = 50;

/**
 * Banners on screen. A Notification that is garbage collected takes its click
 * handler with it, so each one is held until it is clicked, closed or replaced.
 */
const live = new Set<Notification>();
/** What the last banner said: Settings warns while macOS blocks them. */
let state: BannerState = "unknown";

/** The bundle macOS keys notification permission to: the release's, or Electron's own in dev. */
const BUNDLE_ID = app.isPackaged ? "rogazth.crew" : "com.github.Electron";

/** e2e keeps quiet: no beep, and banners without the OS sound. */
const MUTED = process.env.CREW_E2E === "1";

/**
 * A banner's click brings the window up on the session it is about. `window`
 * is the app's one window, if it has one; `reopen` makes it when it was closed.
 */
export function registerNotifyIpc(window: () => BrowserWindow | null, reopen: () => void): void {
  ipcMain.handle(NOTIFY_CHANNELS.show, async (event, banner: Banner) => {
    state = await show(banner, () => {
      const win = window();
      if (!win || win.isDestroyed()) return reopen();
      reveal(win);
      if (!event.sender.isDestroyed()) event.sender.send(NOTIFY_CHANNELS.click, banner.target ?? null);
    });
    return state;
  });
  ipcMain.on(NOTIFY_CHANNELS.beep, () => {
    if (!MUTED) shell.beep();
  });
  ipcMain.handle(NOTIFY_CHANNELS.sound, (_event, path: string) => readSound(path));
  ipcMain.handle(NOTIFY_CHANNELS.status, () => (Notification.isSupported() ? state : "unsupported"));
  ipcMain.on(NOTIFY_CHANNELS.badge, (_event, badge: DockBadge) => setBadge(badge));
  // In front, nothing is waiting unseen; the window says so too, a beat later.
  app.on("browser-window-focus", () => app.setBadgeCount(0));
  app.once("will-quit", () => app.setBadgeCount(0));
  ipcMain.handle(NOTIFY_CHANNELS.settings, () => {
    if (process.platform !== "darwin") return;
    return shell.openExternal(
      `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(BUNDLE_ID)}`,
    );
  });
}

function setBadge(badge: DockBadge): void {
  const focused = BrowserWindow.getFocusedWindow() !== null;
  const count = Number.isFinite(badge.count) ? Math.max(0, Math.floor(badge.count)) : 0;
  app.setBadgeCount(focused ? 0 : count);
  // Informational: once, and only while Crew is not the active app.
  if (badge.bounce && !focused && count > 0) app.dock?.bounce("informational");
}

/** Only an audio file, and only a short one: the renderer asks by path. */
async function readSound(path: unknown): Promise<Uint8Array | null> {
  if (typeof path !== "string" || !isSoundFile(path)) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > SOUND_LIMIT) return null;
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function show(banner: Banner, onClick: () => void): Promise<BannerResult> {
  if (!Notification.isSupported()) return Promise.resolve("unsupported");
  const silent = MUTED || banner.silent === true;
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
