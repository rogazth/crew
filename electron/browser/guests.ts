import { existsSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  session,
  shell,
  systemPreferences,
  type ContextMenuParams,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type PermissionRequest,
  type Session,
  type WebContents,
  type WindowOpenHandlerResponse,
} from "electron";
import { resolveForward, type KeyboardLayout, type LiveCommand } from "../../src/lib/keymap";
import type { NavSnapshot } from "../../src/lib/browser/snapshot";
import {
  CHANNELS,
  isIncognitoPartition,
  isPagePartition,
  LEGACY_PARTITION,
  partitionFor,
  type OpenTabRequest,
} from "../../src/lib/browser/bridge";
import { FILES_PARTITION } from "../../src/lib/browser/files";
import {
  alwaysAllowed,
  decide,
  externalScheme,
  originOf,
  parseSitePermissions,
  permissionKinds,
  verdict,
  type SiteDecision,
  type SitePermission,
  type SitePermissions,
} from "../../src/lib/browser/permissions";
import { copyCookies } from "./cookies";
import { openExternal } from "../external";
import { forgetHost, saveNextAs, trackDownload } from "./downloads";
import { followFile, serveFiles } from "./files";
import { chromeUserAgent, firefoxUserAgent, isGoogleSignIn, outgoingHeaders } from "./identity";
import { ask, dropHost, dropPrompts, type PromptTarget } from "./prompts";
import { relayBypassRules, startRelay, type RemoteRelay } from "./remote-proxy";
import {
  attachDecision,
  certificateBypass,
  createRateLimiter,
  hardenWebPreferences,
  navigationVerdict,
  popupVerdict,
  previewNavigationVerdict,
} from "./policy";

const IS_MAC = process.platform === "darwin";
/**
 * Next to the bundled main. esbuild emits both into electron-dist, and Node's
 * `__dirname` there is that directory. import.meta.url is empty in the cjs bundle.
 */
const GUEST_PRELOAD = path.join(__dirname, "guest-preload.cjs");
/** A login popup's: the sign-in disguise without the close guard, so it can still close itself. */
const POPUP_PRELOAD = path.join(__dirname, "popup-preload.cjs");
/** A snapshot handed over for restore waits this long for its webview to attach. */
const RESTORE_TTL_MS = 10_000;
/**
 * An incognito session is wiped this long after its last page goes, so a page
 * rebuilt after a crash, which drops its guest and attaches a new one, keeps
 * its sign-ins.
 */
const INCOGNITO_WIPE_MS = 1000;

/** Every attached guest, by webContents id, with the window that embeds it. */
const guests = new Map<number, { guest: WebContents; host: WebContents }>();
/** Every login popup, by webContents id: the window and the page that opened it, where its questions show. */
const popups = new Map<number, PromptTarget>();
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
/** The guests attached in each incognito session, by webContents id. */
const incognitoGuests = new Map<string, Set<number>>();
const incognitoWipes = new Map<string, ReturnType<typeof setTimeout>>();

/** Where Electron keeps a persistent partition on disk. */
function partitionDir(partition: string): string {
  return path.join(app.getPath("userData"), "Partitions", partition.replace(/^persist:/, ""));
}

/** Each relay's token, by its port: proxy auth can come without a page (a service worker's fetch). */
const relayTokens = new Map<number, string>();
let loginHooked = false;

/**
 * Electron 44 delivers proxy and site auth on `app`. A relay's challenge is
 * answered with its token; a page's own sign-in (basic or digest auth) asks
 * the person over that page. Anything else keeps Electron's default: no answer.
 */
function hookLogin(): void {
  if (loginHooked) return;
  loginHooked = true;
  app.on("login", (event, webContents, details, authInfo, callback) => {
    if (authInfo.isProxy) {
      if (authInfo.host !== "127.0.0.1") return;
      const token = relayTokens.get(authInfo.port);
      if (!token) return;
      event.preventDefault();
      callback(token, token);
      return;
    }
    if (!webContents || !pageSessionSet.has(webContents.session)) return;
    const target = promptTarget(webContents);
    const origin = originOf(details.url);
    if (!target || !origin) return;
    event.preventDefault();
    void ask(target, {
      kind: "auth",
      origin,
      realm: authInfo.realm.slice(0, 200),
      secure: origin.startsWith("https:"),
    }).then((reply) => {
      if (reply && "username" in reply) callback(reply.username, reply.password);
      else callback();
    });
  });
}

/** One relay per machine, shared by its workspaces' sessions. */
const relays = new Map<string, { relay: Promise<RemoteRelay>; users: Set<Session> }>();
const relayOf = new WeakMap<Session, string>();

async function releaseRelay(ses: Session): Promise<void> {
  const key = relayOf.get(ses);
  if (!key) return;
  relayOf.delete(ses);
  const entry = relays.get(key);
  if (!entry) return;
  entry.users.delete(ses);
  if (entry.users.size > 0) return;
  relays.delete(key);
  const relay = await entry.relay.catch(() => null);
  if (!relay) return;
  relayTokens.delete(relay.port);
  await relay.close();
}

/**
 * A remote workspace's pages reach that machine's loopback through its SOCKS
 * proxy, by way of a relay on this Mac (see remote-proxy.ts). Names that
 * cannot be loopback skip the relay; what it does get that is not loopback it
 * dials from here. Either way the browser does not egress from the VPS.
 */
export async function setWorkspaceProxy(workspaceId: string, proxy: RemoteProxy | null): Promise<void> {
  // Its incognito pages reach the machine the same way, so their session is set up now, before any attaches.
  for (const partition of [partitionFor(workspaceId), partitionFor(workspaceId, true)]) {
    if (partition) await proxySession(pageSession(partition).ses, proxy);
  }
}

type RemoteProxy = { host: string; port: number; token: string };

async function proxySession(ses: Session, proxy: RemoteProxy | null): Promise<void> {
  hookLogin();
  const key = proxy ? `${proxy.host}:${proxy.port}` : null;
  if (relayOf.get(ses) !== key) await releaseRelay(ses);
  if (!proxy || !key) {
    await ses.setProxy({ mode: "direct" });
    return;
  }
  let entry = relays.get(key);
  if (!entry) {
    const started = startRelay(proxy);
    entry = { relay: started, users: new Set() };
    relays.set(key, entry);
    // A relay that could not listen is not kept: the next call starts another.
    started.catch(() => {
      if (relays.get(key)?.relay === started) relays.delete(key);
    });
  }
  entry.users.add(ses);
  relayOf.set(ses, key);
  let relay: RemoteRelay;
  try {
    relay = await entry.relay;
  } catch (error) {
    relayOf.delete(ses);
    await ses.setProxy({ mode: "direct" });
    throw error;
  }
  relay.setToken(proxy.token);
  relayTokens.set(relay.port, proxy.token);
  // `<-loopback>` drops Chromium's implicit bypass, so `localhost` reaches the relay too.
  await ses.setProxy({ mode: "fixed_servers", proxyRules: `127.0.0.1:${relay.port}`, proxyBypassRules: relayBypassRules() });
  // Pages already open kept their direct connections; new ones go through the relay.
  await ses.closeAllConnections();
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
  // An incognito session starts empty: nothing is copied in, and nothing it holds is on disk to find.
  const fresh =
    isPagePartition(partition) &&
    !isIncognitoPartition(partition) &&
    !existsSync(partitionDir(partition)) &&
    existsSync(partitionDir(LEGACY_PARTITION));
  const ses = session.fromPartition(partition);
  if (partition === FILES_PARTITION) serveFiles(ses);
  const seeded = fresh
    ? copyCookies(session.fromPartition(LEGACY_PARTITION), ses).then(
        () => {},
        () => {},
      )
    : Promise.resolve();
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent()));
  const chrome = chromeVersion();
  // The only onBeforeSendHeaders on a page session: Electron keeps one listener per event.
  ses.webRequest.onBeforeSendHeaders((details, callback) =>
    callback({ requestHeaders: outgoingHeaders(details.requestHeaders, details.url, chrome) }),
  );
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    void requestPermission(contents, permission, details, partition).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    checkPermission(permission, originOf(details.requestingUrl) ?? originOf(requestingOrigin), details.mediaType, partition),
  );
  // Screen sharing goes through macOS's own picker, which is the consent. Where there is none, it is refused.
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
  // Downloads need no gesture, so a page could fill the disk; a burst past this is cancelled.
  const allowDownload = createRateLimiter(10, 60_000);
  ses.on("will-download", (_event, item, contents) => {
    if (!allowDownload()) {
      item.cancel();
      return;
    }
    const target = contents ? promptTarget(contents) : null;
    trackDownload(item, target ? { host: target.host, pageId: target.pageId } : null);
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

/** Chromium's version as Chrome reports it: the major alone in `sec-ch-ua`, all four parts in the full list. */
function chromeVersion(): { major: string; full: string } {
  const full = process.versions.chrome ?? "";
  return { major: full.split(".")[0] ?? "", full };
}

/**
 * Site decisions the person asked to keep, as the window last sent them; the
 * window stores them. An incognito session remembers its own, in memory, and
 * forgets them with its sign-ins.
 */
let siteDecisions: SitePermissions = {};
const incognitoDecisions = new Map<string, SitePermissions>();

export function setSitePermissions(value: unknown): void {
  siteDecisions = parseSitePermissions(value);
}

function decisionsFor(partition: string): SitePermissions {
  return isIncognitoPartition(partition) ? (incognitoDecisions.get(partition) ?? {}) : siteDecisions;
}

function remember(partition: string, origin: string, kinds: SitePermission[], decision: SiteDecision): void {
  if (isIncognitoPartition(partition)) {
    incognitoDecisions.set(partition, decide(incognitoDecisions.get(partition) ?? {}, origin, kinds, decision));
  } else {
    siteDecisions = decide(siteDecisions, origin, kinds, decision);
  }
}

/** Where a page's questions show: over the page itself, or over the one that opened its popup. */
function promptTarget(contents: WebContents): PromptTarget | null {
  const guest = guests.get(contents.id);
  if (guest && guest.guest === contents) return { host: guest.host, pageId: contents.id };
  return popups.get(contents.id) ?? null;
}

/** Chromium's question, answered from what the person decided, or put to them over the page. */
async function requestPermission(
  contents: WebContents,
  permission: string,
  details: PermissionRequest & { mediaTypes?: string[]; externalURL?: string },
  partition: string,
): Promise<boolean> {
  if (alwaysAllowed(permission)) return true;
  // A link to another app that no navigation guard saw: a frame's, or a redirect's.
  if (permission === "openExternal") return details.externalURL ? askForApp(contents, details.externalURL) : false;
  const kinds = permissionKinds(permission, details.mediaTypes);
  const origin = originOf(details.requestingUrl) ?? originOf(contents.getURL());
  const target = promptTarget(contents);
  if (!kinds || !origin || !target) return false;
  const decided = verdict(decisionsFor(partition), origin, kinds);
  if (decided.answer === "block") return false;
  if (decided.answer === "ask") {
    const reply = await ask(target, { kind: "permission", origin, permissions: decided.kinds });
    if (!reply || !("allow" in reply)) return false;
    if (reply.remember) remember(partition, origin, decided.kinds, reply.allow ? "allow" : "block");
    if (!reply.allow) return false;
  }
  return systemAllows(target, kinds);
}

/** What a page may read without asking: only what the person already allowed. */
function checkPermission(permission: string, origin: string | null, mediaType: string | undefined, partition: string): boolean {
  if (alwaysAllowed(permission)) return true;
  const kinds = permissionKinds(permission, mediaType === "unknown" ? undefined : mediaType);
  if (!kinds || !origin) return false;
  return verdict(decisionsFor(partition), origin, kinds).answer === "allow";
}

const PRIVACY_PANES: Partial<Record<SitePermission, string>> = {
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

/**
 * macOS has its own say over the camera and microphone. The first time, it
 * asks; once it has said no, the page is refused and the person is told where
 * to change that.
 */
async function systemAllows(target: PromptTarget, kinds: SitePermission[]): Promise<boolean> {
  if (!IS_MAC) return true;
  const blocked: SitePermission[] = [];
  for (const kind of kinds) {
    if (kind !== "camera" && kind !== "microphone") continue;
    const status = systemPreferences.getMediaAccessStatus(kind);
    if (status === "granted") continue;
    if (status === "not-determined" && (await systemPreferences.askForMediaAccess(kind).catch(() => false))) continue;
    blocked.push(kind);
  }
  if (blocked.length === 0) return true;
  void ask(target, { kind: "system", permissions: blocked }).then((reply) => {
    const pane = blocked[0] && PRIVACY_PANES[blocked[0]];
    if (reply && "settings" in reply && reply.settings && pane) void shell.openExternal(pane);
  });
  return false;
}

/** Per page, so one page asking to open Zoom over and over can't bury the others' questions. */
const appLimits = new Map<number, () => boolean>();

/**
 * Another app's link (zoommtg:, slack:, vscode:) opens only after the person
 * says yes over the page. A scheme no app on this Mac handles is dropped.
 */
async function askForApp(contents: WebContents, url: string): Promise<boolean> {
  const scheme = externalScheme(url);
  const target = promptTarget(contents);
  if (!scheme || !target) return false;
  const name = app.getApplicationNameForProtocol(url).replace(/\.app$/i, "");
  if (!name) return false;
  let allow = appLimits.get(target.pageId);
  if (!allow) {
    allow = createRateLimiter(3, 10_000);
    appLimits.set(target.pageId, allow);
  }
  if (!allow()) return false;
  const origin = originOf(contents.getURL()) ?? "";
  const reply = await ask(target, { kind: "external", origin, app: name, scheme });
  return reply !== null && "open" in reply && reply.open;
}

function openApp(contents: WebContents, url: string): void {
  void askForApp(contents, url).then((open) => {
    if (open) void openExternal(url);
  });
}

/**
 * Google's sign-in turns away embedded Chromium, so on its pages a page or a
 * popup goes by Firefox's name, and by Chrome's again once it leaves.
 */
function followSignIn(contents: WebContents): void {
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const agent = isGoogleSignIn(details.url) ? firefoxUserAgent() : contents.session.getUserAgent();
    if (contents.getUserAgent() !== agent) contents.setUserAgent(agent);
  });
}

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
  hookLogin();
  const host = win.webContents;
  host.once("destroyed", () => {
    dropHost(host);
    forgetHost(host);
  });
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

/**
 * Whatever an incognito session gathered goes once its last page does: cookies,
 * storage, cache and HTTP auth. Electron keeps an in-memory session for the
 * app's lifetime, so without this a new incognito tab would still be signed in.
 */
async function wipeIncognito(partition: string): Promise<void> {
  incognitoDecisions.delete(partition);
  const entry = pageSessions.get(partition);
  if (!entry) return;
  const { ses } = entry;
  await Promise.allSettled([ses.clearStorageData(), ses.clearCache(), ses.clearAuthCache(), ses.clearHostResolverCache()]);
  await ses.closeAllConnections().catch(() => {});
}

function trackIncognito(guest: WebContents, partition: string): void {
  clearTimeout(incognitoWipes.get(partition));
  incognitoWipes.delete(partition);
  let open = incognitoGuests.get(partition);
  if (!open) {
    open = new Set();
    incognitoGuests.set(partition, open);
  }
  open.add(guest.id);
  const id = guest.id;
  guest.once("destroyed", () => {
    const left = incognitoGuests.get(partition);
    left?.delete(id);
    if (left && left.size > 0) return;
    incognitoGuests.delete(partition);
    incognitoWipes.set(
      partition,
      setTimeout(() => {
        incognitoWipes.delete(partition);
        void wipeIncognito(partition);
      }, INCOGNITO_WIPE_MS),
    );
  });
}

function register(host: WebContents, guest: WebContents, partition: string): void {
  const id = guest.id;
  guests.set(id, { guest, host });
  guest.once("destroyed", () => {
    if (guests.get(id)?.guest === guest) guests.delete(id);
    appLimits.delete(id);
    dropPrompts(id);
  });
  if (isIncognitoPartition(partition)) trackIncognito(guest, partition);

  const allowOpen = createRateLimiter(4, 2000);
  guest.setWindowOpenHandler((details) => windowOpen(host, guest, id, partition, details, allowOpen));
  guest.on("did-create-window", (child) => guardPopup(host, id, partition, child.webContents, allowOpen));
  if (partition === FILES_PARTITION) {
    guardPreview(host, guest);
    followFile(guest);
  } else {
    guardNavigation(guest);
    followSignIn(guest);
  }
  // A question asked by the page it left is no longer the page's to answer.
  guest.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropPrompts(id);
  });
  const responsive = (hung: boolean) => {
    if (!host.isDestroyed()) host.send(CHANNELS.responsive, { webContentsId: id, hung });
  };
  guest.on("unresponsive", () => responsive(true));
  guest.on("responsive", () => responsive(false));

  forwardCommands(host, guest);

  guest.on("context-menu", (_event, params) => {
    const win = BrowserWindow.fromWebContents(host);
    if (!win) return;
    Menu.buildFromTemplate(contextMenu(host, guest, partition, params)).popup({ window: win });
  });
}

/** A chord the window runs is sent to it instead of reaching the page. */
export function forwardCommands(host: WebContents, contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
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
}

function windowOpen(
  host: WebContents,
  source: WebContents,
  openerId: number,
  partition: string,
  details: HandlerDetails,
  allowOpen: () => boolean,
): WindowOpenHandlerResponse {
  const decision = popupVerdict(details);
  // The mail app counts against the same budget, or a page could spam it.
  if (decision.action === "deny" || !allowOpen()) return { action: "deny" };
  if (decision.action === "external") {
    void openExternal(decision.url);
    return { action: "deny" };
  }
  if (decision.action === "ask") {
    openApp(source, decision.url);
    return { action: "deny" };
  }
  if (decision.action === "download") {
    source.downloadURL(decision.url);
    return { action: "deny" };
  }
  const verdict = decision;
  if (verdict.action === "tab") {
    openTab(host, { url: verdict.url, background: verdict.background, openerId, incognito: isIncognitoPartition(partition) });
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
        preload: POPUP_PRELOAD,
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
  const id = popup.id;
  popups.set(id, { host, pageId: openerId });
  popup.once("destroyed", () => {
    popups.delete(id);
    dropPrompts(id);
  });
  guardNavigation(popup);
  followSignIn(popup);
  popup.setWindowOpenHandler((details) => windowOpen(host, popup, openerId, partition, details, allowOpen));
  popup.on("did-create-window", (child) => guardPopup(host, openerId, partition, child.webContents, allowOpen));
}

function guardNavigation(contents: WebContents): void {
  const guard = (event: { url: string; preventDefault: () => void }) => {
    const verdict = navigationVerdict(event.url);
    if (verdict === "allow") return;
    event.preventDefault();
    if (verdict === "external") void openExternal(event.url);
    else if (verdict === "ask") openApp(contents, event.url);
    else if (verdict === "download") contents.downloadURL(event.url);
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
    if (verdict === "tab") openTab(host, { url: event.url, background: false, openerId: guest.id, incognito: false });
    if (verdict === "external") void openExternal(event.url);
  };
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
}

function contextMenu(
  host: WebContents,
  guest: WebContents,
  partition: string,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  const group = (next: MenuItemConstructorOptions[]) => {
    if (next.length === 0) return;
    if (items.length > 0) items.push({ type: "separator" });
    items.push(...next);
  };
  const link = navigationVerdict(params.linkURL) === "allow" && params.linkURL !== "about:blank";
  // An incognito page's new tabs are incognito already.
  const incognito = isIncognitoPartition(partition);
  const open = (inIncognito: boolean) => () =>
    openTab(host, { url: params.linkURL, background: true, openerId: guest.id, incognito: inIncognito });
  const saveAs = (url: string) => () => {
    saveNextAs(url);
    guest.downloadURL(url);
  };
  group(
    link
      ? [
          { label: "Open Link in New Tab", click: open(incognito) },
          ...(incognito ? [] : [{ label: "Open Link in Incognito Tab", click: open(true) }]),
          { label: "Open Link in Default Browser", click: () => void openExternal(params.linkURL) },
          { type: "separator" },
          { label: "Save Link As…", click: saveAs(params.linkURL) },
          { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        ]
      : [],
  );
  const image = params.mediaType === "image" && params.hasImageContents;
  const imageUrl = image && navigationVerdict(params.srcURL) === "allow" ? params.srcURL : null;
  group(
    image
      ? [
          ...(imageUrl
            ? [
                {
                  label: "Open Image in New Tab",
                  click: () => openTab(host, { url: imageUrl, background: true, openerId: guest.id, incognito }),
                },
              ]
            : []),
          { label: "Save Image As…", click: saveAs(params.srcURL) },
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
  group([{ label: "Print…", click: () => guest.print() }]);
  group([{ label: "Inspect Element", click: () => guest.inspectElement(params.x, params.y) }]);
  return items;
}
