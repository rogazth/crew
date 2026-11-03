/**
 * A sign-in, in a window of its own over Crew's: a connector's, or a provider
 * server's on any machine. It shares the pages' session (or the incognito
 * one, for another account of a connector already signed in), so a service
 * the person is signed in to answers in one click. It is no tab: no agent can
 * list, drive or open it, so an agent cannot consent for the person. The
 * window catches the navigation to the flow's loopback redirect URI, cancels
 * it, closes itself and resolves the window's call with the URL. The caller
 * decides where the URL goes (`src/lib/signInWindow.ts`): `vault_callback`
 * on this Mac, or `provider_server_callback` on the machine that started it.
 *
 * Google's sign-in opens no window: it goes to the person's browser instead
 * and resolves the same way (sign-in-loopback.ts).
 */

import { BrowserWindow, ipcMain, type WebContents, type WebPreferences } from "electron";
import { CHANNELS, CREW_REDIRECT_URI, isIncognitoPartition, opensInSystemBrowser, partitionFor, type SignInOutcome, type SignInRequest } from "../../src/lib/browser/bridge";
import { openExternal } from "../external";
import { followSignIn, guardNavigation, pageSession, POPUP_PRELOAD, setRequestInterceptor, trackIncognito } from "./guests";
import { popupVerdict } from "./policy";
import { FlowRegistry, signInRequest, type PendingFlow } from "./sign-in-flows";
import { LoopbackSignIns } from "./sign-in-loopback";

type Flow = PendingFlow & {
  window: BrowserWindow;
  host: WebContents;
  resolve: (outcome: SignInOutcome) => void;
  /** Stops watching Crew's window for a reload. */
  release: () => void;
};

const flows = new FlowRegistry<Flow>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Delivers the outcome once and lets the window go. */
function finish(state: string, outcome: SignInOutcome): void {
  const flow = flows.get(state);
  if (!flow || !flows.settle(state)) return;
  flow.release();
  flow.resolve(outcome);
  // Not from inside the navigation event that caught it.
  setImmediate(() => {
    if (!flow.window.isDestroyed()) flow.window.destroy();
  });
}

/** Answers whether `url` was this page's flow's redirect, and settles the flow if so. */
function intercept(contentsId: number | undefined, url: string): boolean {
  const decision = flows.decide(contentsId, url);
  if (decision.action === "pass") return false;
  finish(decision.state, decision.action === "catch" ? { kind: "caught", url: decision.url } : { kind: "refused" });
  return true;
}

function preferences(partition: string): WebPreferences {
  return {
    preload: POPUP_PRELOAD,
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // The preload in every iframe as well; the sandbox still keeps Node out.
    nodeIntegrationInSubFrames: true,
    webSecurity: true,
    webviewTag: false,
  };
}

/** The flow's window and its popups: guarded like any page, and catching the redirect before anything else sees it. */
function watch(contents: WebContents, state: string, partition: string): void {
  const catchRedirect = (event: { url: string; preventDefault: () => void }) => {
    if (intercept(contents.id, event.url)) event.preventDefault();
  };
  // First, so the redirect never reaches the navigation guard or the network.
  contents.on("will-navigate", catchRedirect);
  contents.on("will-redirect", catchRedirect);
  guardNavigation(contents);
  followSignIn(contents);
  if (isIncognitoPartition(partition)) trackIncognito(contents, partition);
  const id = contents.id;
  contents.once("destroyed", () => flows.forget(id));
  contents.setWindowOpenHandler((details) => {
    const verdict = popupVerdict(details);
    // A link to read (terms, privacy) goes to the person's browser; the sign-in stays here.
    if (verdict.action === "tab" || verdict.action === "external") void openExternal(verdict.url);
    if (verdict.action !== "window") return { action: "deny" };
    // A "Sign in with…" popup keeps window.opener, in the same session, and belongs to the flow.
    return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: preferences(partition) } };
  });
  contents.on("did-create-window", (child) => {
    flows.adopt(child.webContents.id, state);
    watch(child.webContents, state, partition);
  });
}

const inBrowser = new LoopbackSignIns({ port: Number(new URL(CREW_REDIRECT_URI).port), open: openExternal });
/** The window that started each sign-in in the person's browser. */
const inBrowserHosts = new Map<string, WebContents>();

function openInBrowser(host: WebContents, request: SignInRequest): Promise<SignInOutcome> {
  const { state } = request;
  const outcome = inBrowser.start(request);
  // A second start: that ended the first too, and the first's own wiring lets go.
  if (inBrowserHosts.has(state)) return outcome;
  inBrowserHosts.set(state, host);
  // Crew's window reloading or closing takes the sign-in with it, as with a window of its own.
  const drop = () => inBrowser.abort(state);
  const reload = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
    if (details.isMainFrame && !details.isSameDocument) drop();
  };
  host.on("destroyed", drop);
  host.on("did-start-navigation", reload);
  return outcome.finally(() => {
    inBrowserHosts.delete(state);
    if (host.isDestroyed()) return;
    host.off("destroyed", drop);
    host.off("did-start-navigation", reload);
  });
}

function open(host: WebContents, raw: unknown): Promise<SignInOutcome> {
  const request = signInRequest(raw);
  // Only Crew's window starts a flow: never a page, never a flow's own window.
  if (!request || host.getType() !== "window" || flows.flowOf(host.id)) return Promise.resolve({ kind: "closed" });
  if (opensInSystemBrowser(request)) return openInBrowser(host, request);
  // A second start of the same flow brings its window forward.
  const existing = flows.get(request.state);
  if (existing) {
    existing.window.focus();
    return Promise.resolve({ kind: "closed" });
  }
  const partition = partitionFor(request.incognito);
  // Sets the session up the way every page's is, the request guard included.
  pageSession(partition);
  const parent = BrowserWindow.fromWebContents(host) ?? undefined;
  const window = new BrowserWindow({
    ...(parent ? { parent } : {}),
    width: 520,
    height: 720,
    minWidth: 360,
    minHeight: 420,
    title: hostOf(request.authUrl),
    autoHideMenuBar: true,
    webPreferences: preferences(partition),
  });
  const contents = window.webContents;
  return new Promise<SignInOutcome>((resolve) => {
    // Crew's window reloading or closing takes its sign-ins with it: nobody would hear the outcome.
    const drop = () => finish(request.state, { kind: "closed" });
    const reload = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) drop();
    };
    host.on("destroyed", drop);
    host.on("did-start-navigation", reload);
    const release = () => {
      host.off("destroyed", drop);
      host.off("did-start-navigation", reload);
    };
    flows.start(contents.id, { state: request.state, redirectUri: request.redirectUri, window, host, resolve, release });
    watch(contents, request.state, partition);
    // The title says whose page it is, since the window has no address bar.
    const titled = () => {
      if (!window.isDestroyed()) window.setTitle(hostOf(contents.getURL()) || "Sign in");
    };
    contents.on("page-title-updated", (event) => {
      event.preventDefault();
      titled();
    });
    contents.on("did-navigate", titled);
    window.once("closed", drop);
    void contents.loadURL(request.authUrl).catch(() => {
      // A page that fails to load still shows its error; the person closes the window.
    });
  });
}

export function registerSignInIpc(): void {
  setRequestInterceptor(intercept);
  ipcMain.handle(CHANNELS.signIn, (event, request: unknown) => open(event.sender, request));
  ipcMain.handle(CHANNELS.signInAbort, (event, state: unknown) => {
    if (typeof state !== "string") return;
    if (inBrowserHosts.get(state) === event.sender) return inBrowser.abort(state);
    const flow = flows.get(state);
    if (flow && flow.host === event.sender) finish(state, { kind: "closed" });
  });
}
