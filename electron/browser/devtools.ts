import { BrowserWindow, WebContentsView, type Rectangle, type WebContents } from "electron";
import type { DockBounds, DockSnapshot } from "../../src/lib/browser/bridge";
import { forwardCommands } from "./guests";

/**
 * A page's DevTools docked beside it. Electron's frontend stays blank in a
 * <webview> (electron/electron#15874), so it lives in a view of the window
 * that main lays over the pane's panel, wherever the window says it is.
 */
type Dock = { view: WebContentsView; win: BrowserWindow; host: WebContents; guest: WebContents };

/** By the id of the page each one inspects. */
const docks = new Map<number, Dock>();

/** The window lays out in CSS pixels; views are placed in its zoomed ones. */
function toWindow(host: WebContents, bounds: DockBounds): Rectangle {
  const zoom = host.getZoomFactor();
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(0, Math.round(bounds.width * zoom)),
    height: Math.max(0, Math.round(bounds.height * zoom)),
  };
}

/** Only numbers from the renderer; anything else places nothing. */
export function dockBounds(value: unknown): DockBounds | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Partial<Record<keyof DockBounds, unknown>>;
  const all = [x, y, width, height];
  if (!all.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 100_000)) return null;
  return { x, y, width, height } as DockBounds;
}

function remove(guestId: number): void {
  const dock = docks.get(guestId);
  if (!dock) return;
  docks.delete(guestId);
  if (!dock.guest.isDestroyed()) dock.guest.closeDevTools();
  if (!dock.win.isDestroyed()) {
    // Focus left in a view that goes would leave the window without a keyboard.
    if (!dock.view.webContents.isDestroyed() && dock.view.webContents.isFocused()) dock.host.focus();
    dock.win.contentView.removeChildView(dock.view);
  }
  if (!dock.view.webContents.isDestroyed()) dock.view.webContents.close();
}

/** Opens `guest`'s DevTools over the panel at `bounds`; ones in a window of their own move there. */
export function dockDevTools(host: WebContents, guest: WebContents, bounds: DockBounds): boolean {
  if (docks.has(guest.id)) return true;
  const win = BrowserWindow.fromWebContents(host);
  if (!win) return false;
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Main loads the frontend; the view itself goes nowhere.
  const guard = (event: { url: string; preventDefault: () => void }) => {
    if (!event.url.startsWith("devtools://")) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  forwardCommands(host, contents);
  win.contentView.addChildView(view);
  view.setBounds(toWindow(host, bounds));
  docks.set(guest.id, { view, win, host, guest });
  guest.once("destroyed", () => remove(guest.id));
  win.once("closed", () => remove(guest.id));

  if (guest.isDevToolsOpened()) guest.closeDevTools();
  guest.setDevToolsWebContents(contents);
  guest.openDevTools();
  return true;
}

/**
 * Puts the view over the panel again, or hides it while something of the
 * window covers the panel: the view sits above all of the window's own
 * drawing. Hiding answers with how it looked, for the panel to show instead.
 */
export async function placeDevTools(
  host: WebContents,
  guestId: number,
  bounds: DockBounds | null,
): Promise<DockSnapshot | null> {
  const dock = docks.get(guestId);
  if (!dock || dock.host !== host || dock.win.isDestroyed()) return null;
  const { view } = dock;
  if (bounds) {
    view.setBounds(toWindow(host, bounds));
    view.setVisible(true);
    return null;
  }
  if (!view.getVisible()) return null;
  // Asked for before hiding, so the frame is the one on screen.
  const capture = view.webContents.capturePage();
  if (view.webContents.isFocused()) host.focus();
  view.setVisible(false);
  const image = await capture.catch(() => null);
  if (!image || image.isEmpty()) return null;
  // The image is in device pixels; it covered the view exactly.
  const zoom = host.getZoomFactor();
  const { width, height } = view.getBounds();
  return { url: image.toDataURL(), width: width / zoom, height: height / zoom };
}

/** Only docked DevTools: ones in a window of their own are the toggle's to close. */
export function undockDevTools(host: WebContents, guestId: number): void {
  if (docks.get(guestId)?.host === host) remove(guestId);
}
