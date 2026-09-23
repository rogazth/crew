import { existsSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  Notification,
  session,
  shell,
  type ContextMenuParams,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
  type WindowOpenHandlerResponse,
} from "electron";
import { resolveForward, type LiveCommand } from "../../src/lib/keymap";
import type { NavSnapshot } from "../../src/lib/browser/snapshot";
import { CHANNELS, type OpenTabRequest } from "../../src/lib/browser/bridge";
import {
  PARTITION,
  attachDecision,
  browserUserAgent,
  certificateBypass,
  createRateLimiter,
  hardenWebPreferences,
  navigationVerdict,
  permissionAllowed,
  popupVerdict,
} from "./policy";

const IS_MAC = process.platform === "darwin";
/** A snapshot handed over for restore waits this long for its webview to attach. */
const RESTORE_TTL_MS = 10_000;

/** Every attached guest, by webContents id, with the window that embeds it. */
const guests = new Map<number, { guest: WebContents; host: WebContents }>();
/** What each window can run right now; a chord inside one of its pages is checked against this. */
const liveCommands = new WeakMap<WebContents, LiveCommand[]>();
const pendingRestores = new Map<string, { snapshot: NavSnapshot; expires: number }>();
/**
 * will-attach-webview sees the webview's params, did-attach-webview sees its
 * webContents, and nothing carries an id from one to the other. Both fire in
 * attach order for one window, so a queue pairs them.
 */
const attachQueues = new WeakMap<WebContents, (string | null)[]>();

let browserSession: Session | null = null;

/** The partition every page lives in: its own cookies, and none of the app window's CSP. */
function configureSession(): Session {
  if (browserSession) return browserSession;
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
  ses.on("will-download", (_event, item) => {
    const target = uniquePath(app.getPath("downloads"), path.basename(item.getFilename()) || "download");
    item.setSavePath(target);
    item.once("done", (_e, state) => {
      if (state !== "completed" || !Notification.isSupported()) return;
      const note = new Notification({ title: "Download complete", body: path.basename(target) });
      note.on("click", () => shell.showItemInFolder(target));
      note.show();
    });
  });
  // Only local dev servers get past a bad certificate; everything else keeps Chromium's refusal.
  app.on("certificate-error", (event, wc, url, _error, _cert, callback) => {
    if (wc.session !== ses) return;
    event.preventDefault();
    callback(certificateBypass(url));
  });
  browserSession = ses;
  return ses;
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function attachQueue(host: WebContents): (string | null)[] {
  let queue = attachQueues.get(host);
  if (!queue) {
    queue = [];
    attachQueues.set(host, queue);
  }
  return queue;
}

/** Hooks a window so every <webview> it creates is vetted, hardened, and wired before its page runs. */
export function installBrowser(win: BrowserWindow): void {
  configureSession();
  const host = win.webContents;
  host.on("will-attach-webview", (event, prefs, params) => {
    const decision = attachDecision(params);
    if (!decision.allow) {
      event.preventDefault();
      return;
    }
    hardenWebPreferences(prefs as Record<string, unknown>);
    const token = decision.restoreToken;
    if (token && pendingRestores.has(token)) {
      // restore() only works on a webContents that has never loaded anything.
      params.src = "";
      attachQueue(host).push(token);
    } else {
      if (token) params.src = "about:blank";
      attachQueue(host).push(null);
    }
  });
  host.on("did-attach-webview", (_event, guest) => {
    const token = attachQueue(host).shift() ?? null;
    register(host, guest);
    if (token) restore(guest, token);
  });
}

function restore(guest: WebContents, token: string): void {
  const pending = pendingRestores.get(token);
  pendingRestores.delete(token);
  if (!pending) return;
  const { snapshot } = pending;
  guest.navigationHistory.restore(snapshot).catch(() => {
    // The stack is a convenience; the page is not. Fall back to its URL.
    const active = snapshot.entries[snapshot.index];
    if (active && !guest.isDestroyed()) void guest.loadURL(active.url).catch(() => {});
  });
}

export function prepareRestore(token: string, snapshot: NavSnapshot): void {
  const now = Date.now();
  for (const [key, entry] of pendingRestores) if (entry.expires < now) pendingRestores.delete(key);
  pendingRestores.set(token, { snapshot, expires: now + RESTORE_TTL_MS });
}

export function setLiveCommands(host: WebContents, commands: LiveCommand[]): void {
  liveCommands.set(host, commands);
}

/** A guest the asking window actually embeds; ids from the renderer are never trusted on their own. */
export function ownedGuest(host: WebContents, id: number): WebContents | null {
  const entry = guests.get(id);
  if (!entry || entry.host !== host || entry.guest.isDestroyed()) return null;
  return entry.guest;
}

function openTab(host: WebContents, request: OpenTabRequest): void {
  if (!host.isDestroyed()) host.send(CHANNELS.openTab, request);
}

function register(host: WebContents, guest: WebContents): void {
  guests.set(guest.id, { guest, host });
  guest.once("destroyed", () => {
    if (guests.get(guest.id)?.guest === guest) guests.delete(guest.id);
  });

  const allowOpen = createRateLimiter(4, 2000);
  guest.setWindowOpenHandler((details) => windowOpen(host, guest.id, details, allowOpen));
  guest.on("did-create-window", (child) => guardPopup(host, guest.id, child.webContents, allowOpen));
  guardNavigation(guest);

  guest.on("before-input-event", (event, input) => {
    if (input.isComposing) return;
    const forward = resolveForward(
      {
        type: input.type,
        key: input.key,
        code: input.code,
        meta: input.meta,
        ctrl: input.control,
        alt: input.alt,
        shift: input.shift,
        isAutoRepeat: input.isAutoRepeat,
      },
      liveCommands.get(host) ?? [],
      IS_MAC,
    );
    if (!forward) return;
    event.preventDefault();
    if (forward.run && !host.isDestroyed()) host.send(CHANNELS.command, forward.id);
  });

  guest.on("context-menu", (_event, params) => {
    const win = BrowserWindow.fromWebContents(host);
    if (!win) return;
    Menu.buildFromTemplate(contextMenu(host, guest, params)).popup({ window: win });
  });
}

function windowOpen(
  host: WebContents,
  openerId: number,
  details: HandlerDetails,
  allowOpen: () => boolean,
): WindowOpenHandlerResponse {
  const verdict = popupVerdict(details);
  if (verdict.action === "external") {
    void shell.openExternal(verdict.url);
    return { action: "deny" };
  }
  if (verdict.action === "deny" || !allowOpen()) return { action: "deny" };
  if (verdict.action === "tab") {
    openTab(host, { url: verdict.url, background: verdict.background, openerId });
    return { action: "deny" };
  }
  // A login popup keeps window.opener, so it gets a real window in the same partition.
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    },
  };
}

function guardPopup(host: WebContents, openerId: number, popup: WebContents, allowOpen: () => boolean): void {
  guardNavigation(popup);
  popup.setWindowOpenHandler((details) => windowOpen(host, openerId, details, allowOpen));
}

function guardNavigation(contents: WebContents): void {
  const guard = (event: { url: string; preventDefault: () => void }) => {
    const verdict = navigationVerdict(event.url);
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "external") void shell.openExternal(event.url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}

function contextMenu(host: WebContents, guest: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const group = (next: MenuItemConstructorOptions[]) => {
    if (next.length === 0) return;
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...next);
  };
  const link = navigationVerdict(params.linkURL) === "allow" && params.linkURL !== "about:blank";
  group(
    link
      ? [
          {
            label: "Open Link in New Tab",
            click: () => openTab(host, { url: params.linkURL, background: true, openerId: guest.id }),
          },
          { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        ]
      : [],
  );
  group(
    params.mediaType === "image" && params.hasImageContents
      ? [
          { label: "Copy Image", click: () => guest.copyImageAt(params.x, params.y) },
          { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
        ]
      : [],
  );
  if (params.isEditable) {
    group([
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText.trim()) {
    group([{ role: "copy" }]);
  }
  const history = guest.navigationHistory;
  group([
    { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
    { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
    { label: "Reload", click: () => guest.reload() },
  ]);
  group([{ label: "Inspect Element", click: () => guest.inspectElement(params.x, params.y) }]);
  return items;
}
