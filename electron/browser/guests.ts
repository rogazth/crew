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
import { resolveForward, type KeyboardLayout, type LiveCommand } from "../../src/lib/keymap";
import type { NavSnapshot } from "../../src/lib/browser/snapshot";
import { CHANNELS, isPagePartition, LEGACY_PARTITION, type OpenTabRequest } from "../../src/lib/browser/bridge";
import { FILES_PARTITION } from "../../src/lib/browser/files";
import { copyCookies } from "./cookies";
import { openExternal } from "../external";
import { followFile, serveFiles } from "./files";
import {
  attachDecision,
  browserUserAgent,
  certificateBypass,
  createRateLimiter,
  hardenWebPreferences,
  navigationVerdict,
  permissionAllowed,
  popupVerdict,
  previewNavigationVerdict,
} from "./policy";

const IS_MAC = process.platform === "darwin";
/**
 * Next to the bundled main. esbuild emits both into electron-dist, and Node's
 * `__dirname` there is that directory. import.meta.url is empty in the cjs bundle.
 */
const GUEST_PRELOAD = path.join(__dirname, "guest-preload.cjs");
/** A snapshot handed over for restore waits this long for its webview to attach. */
const RESTORE_TTL_MS = 10_000;

/** Every attached guest, by webContents id, with the window that embeds it. */
const guests = new Map<number, { guest: WebContents; host: WebContents }>();
/** What each window can run right now; a chord inside one of its pages is checked against this. */
const liveCommands = new WeakMap<WebContents, LiveCommand[]>();
const keyboardLayouts = new WeakMap<WebContents, KeyboardLayout>();
const pendingRestores = new Map<string, { snapshot: NavSnapshot; expires: number }>();
/**
 * will-attach-webview sees the webview's params, did-attach-webview sees its
 * webContents, and nothing carries an id from one to the other. Both fire in
 * attach order for one window, so a queue pairs them.
 */
const attachQueues = new WeakMap<WebContents, Attach[]>();
type Attach = { partition: string; token: string | null };

/** Each workspace's page session, set up the first time one of its pages attaches. */
const pageSessions = new Map<string, { ses: Session; seeded: Promise<void> }>();
const pageSessionSet = new WeakSet<Session>();

/** Where Electron keeps a persistent partition on disk. */
function partitionDir(partition: string): string {
  return path.join(app.getPath("userData"), "Partitions", partition.replace(/^persist:/, ""));
}

/**
 * A workspace's pages: their own cookies, and none of the app window's CSP.
 * A partition seen for the first time starts from the shared one pages used
 * before workspaces had their own, so an upgrade keeps its sign-ins. The copy
 * takes milliseconds, once per workspace; a page that loads inside that window
 * shows signed out until its next load.
 */
function pageSession(partition: string): { ses: Session; seeded: Promise<void> } {
  const existing = pageSessions.get(partition);
  if (existing) return existing;
  const fresh =
    isPagePartition(partition) && !existsSync(partitionDir(partition)) && existsSync(partitionDir(LEGACY_PARTITION));
  const ses = session.fromPartition(partition);
  if (partition === FILES_PARTITION) serveFiles(ses);
  const seeded = fresh
    ? copyCookies(session.fromPartition(LEGACY_PARTITION), ses).then(
        () => {},
        () => {},
      )
    : Promise.resolve();
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()));
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permissionAllowed(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => permissionAllowed(permission));
  // Downloads need no gesture, so a page could fill the disk; a burst past this is cancelled.
  const allowDownload = createRateLimiter(10, 60_000);
  ses.on("will-download", (_event, item, contents) => {
    if (!allowDownload()) {
      item.cancel();
      return;
    }
    const owner = contents ? guests.get(contents.id)?.host : undefined;
    const report = (active: boolean) => {
      if (owner && !owner.isDestroyed()) owner.send(CHANNELS.download, { webContentsId: contents.id, active });
    };
    report(true);
    const target = uniquePath(app.getPath("downloads"), path.basename(item.getFilename()) || "download");
    item.setSavePath(target);
    item.once("done", (_e, state) => {
      report(false);
      if (state !== "completed" || !Notification.isSupported()) return;
      const note = new Notification({ title: "Download complete", body: path.basename(target) });
      note.on("click", () => shell.showItemInFolder(target));
      note.show();
    });
  });
  const entry = { ses, seeded };
  pageSessions.set(partition, entry);
  pageSessionSet.add(ses);
  return entry;
}

/** A workspace's page session once any first-time copy has landed, so a write after it wins. */
export async function readyPageSession(partition: string): Promise<Session> {
  const { ses, seeded } = pageSession(partition);
  await seeded;
  return ses;
}

let certificatesGuarded = false;

/** Only local dev servers get past a bad certificate; everything else keeps Chromium's refusal. */
function guardCertificates(): void {
  if (certificatesGuarded) return;
  certificatesGuarded = true;
  app.on("certificate-error", (event, wc, url, _error, _cert, callback) => {
    if (!pageSessionSet.has(wc.session)) return;
    event.preventDefault();
    callback(certificateBypass(url));
  });
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function attachQueue(host: WebContents): Attach[] {
  let queue = attachQueues.get(host);
  if (!queue) {
    queue = [];
    attachQueues.set(host, queue);
  }
  return queue;
}

/** Hooks a window so every <webview> it creates is vetted, hardened, and wired before its page runs. */
export function installBrowser(win: BrowserWindow): void {
  guardCertificates();
  const host = win.webContents;
  host.on("will-attach-webview", (event, prefs, params) => {
    const decision = attachDecision(params);
    if (!decision.allow) {
      event.preventDefault();
      return;
    }
    // The attribute is how a preload arrives; the merged prefs are what Electron uses.
    delete params.preload;
    const { partition } = decision;
    pageSession(partition);
    hardenWebPreferences(prefs as Record<string, unknown>, GUEST_PRELOAD, partition);
    const token = decision.restoreToken;
    if (token && pendingRestores.has(token)) {
      // restore() only works on a webContents that has never loaded anything.
      params.src = "";
      attachQueue(host).push({ partition, token });
    } else {
      if (token) params.src = "about:blank";
      attachQueue(host).push({ partition, token: null });
    }
  });
  host.on("did-attach-webview", (_event, guest) => {
    const attach = attachQueue(host).shift();
    if (!attach) return;
    register(host, guest, attach.partition);
    if (attach.token) restore(guest, attach.token);
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

export function setKeyboardLayout(host: WebContents, layout: KeyboardLayout | undefined): void {
  if (layout) keyboardLayouts.set(host, layout);
  else keyboardLayouts.delete(host);
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

function register(host: WebContents, guest: WebContents, partition: string): void {
  guests.set(guest.id, { guest, host });
  guest.once("destroyed", () => {
    if (guests.get(guest.id)?.guest === guest) guests.delete(guest.id);
  });

  const allowOpen = createRateLimiter(4, 2000);
  guest.setWindowOpenHandler((details) => windowOpen(host, guest.id, partition, details, allowOpen));
  guest.on("did-create-window", (child) => guardPopup(host, guest.id, partition, child.webContents, allowOpen));
  if (partition === FILES_PARTITION) {
    guardPreview(host, guest);
    followFile(guest);
  } else {
    guardNavigation(guest);
  }

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
      keyboardLayouts.get(host),
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
  partition: string,
  details: HandlerDetails,
  allowOpen: () => boolean,
): WindowOpenHandlerResponse {
  const verdict = popupVerdict(details);
  // The mail app counts against the same budget, or a page could spam it.
  if (verdict.action === "deny" || !allowOpen()) return { action: "deny" };
  if (verdict.action === "external") {
    void openExternal(verdict.url);
    return { action: "deny" };
  }
  if (verdict.action === "tab") {
    openTab(host, { url: verdict.url, background: verdict.background, openerId });
    return { action: "deny" };
  }
  // A preview has no sign-in for a popup to finish.
  if (partition === FILES_PARTITION) return { action: "deny" };
  // A login popup keeps window.opener, so it gets a real window in the same partition.
  // No close-guard preload: this window is supposed to be able to close itself.
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    },
  };
}

/** Applies to a popup's own popups too, however deep: a window with no handler would open unguarded. */
function guardPopup(
  host: WebContents,
  openerId: number,
  partition: string,
  popup: WebContents,
  allowOpen: () => boolean,
): void {
  guardNavigation(popup);
  popup.setWindowOpenHandler((details) => windowOpen(host, openerId, partition, details, allowOpen));
  popup.on("did-create-window", (child) => guardPopup(host, openerId, partition, child.webContents, allowOpen));
}

function guardNavigation(contents: WebContents): void {
  const guard = (event: { url: string; preventDefault: () => void }) => {
    const verdict = navigationVerdict(event.url);
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "external") void openExternal(event.url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
}

/** A preview stays on files; a link to the web opens a browser tab beside it. */
function guardPreview(host: WebContents, guest: WebContents): void {
  const guard = (event: { url: string; preventDefault: () => void }) => {
    const verdict = previewNavigationVerdict(event.url);
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "tab") openTab(host, { url: event.url, background: false, openerId: guest.id });
    if (verdict === "external") void openExternal(event.url);
  };
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
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
