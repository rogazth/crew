import { PARTITION } from "./bridge";

/**
 * The slice of Electron's <webview> element the pane uses. The renderer build
 * has no Electron types, so it is spelled out here.
 */
type WebviewElement = HTMLElement & {
  getWebContentsId(): number;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
};

export type FindResult = { activeMatchOrdinal: number; matches: number };

export type LoadFailure = {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
};

export type GuestEvents = {
  attach(webContentsId: number): void;
  /** A main-frame navigation committed. `inPage` is a pushState or a fragment change. */
  navigate(url: string, inPage: boolean): void;
  /** A main-frame navigation started for real (not in place): the old page's error and favicon may go. */
  start(url: string): void;
  loading(loading: boolean): void;
  title(title: string): void;
  favicon(url: string | null): void;
  fail(failure: LoadFailure): void;
  /** The page's process died, or the guest went away while its element was still in the document. */
  gone(): void;
  devtools(open: boolean): void;
  media(playing: boolean): void;
  focus(): void;
  found(result: FindResult): void;
};

export type Guest = {
  element: HTMLElement;
  webContentsId(): number | null;
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** `next` walks the current matches; without it the search starts over. */
  find(text: string, next?: { forward: boolean }): void;
  stopFind(): void;
  zoom(): number;
  setZoom(factor: number): void;
  focus(): void;
  /** Hands focus back to the window; a hidden guest that keeps it makes macOS activate another app. */
  release(): void;
  destroy(): void;
};

/**
 * Builds the <webview> outside React and never moves it: removing or
 * reparenting the element destroys the page with its forms, scroll and
 * history. Listeners go on before `src`, so a fast failure (a dev server that
 * is down) is not missed.
 */
export function createGuest(container: HTMLElement, src: string, on: GuestEvents): Guest {
  const view = document.createElement("webview") as WebviewElement;
  view.setAttribute("partition", PARTITION);
  view.setAttribute("allowpopups", "");
  // Without an explicit flex display the guest keeps its 150px default height.
  view.style.cssText = "display:flex;position:absolute;inset:0;width:100%;height:100%;border:0";

  let id: number | null = null;
  let ready = false;
  let destroyed = false;

  /** Every call into the guest throws before dom-ready and after its process dies. */
  const safely = <T>(fn: () => T, fallback: T): T => {
    if (destroyed) return fallback;
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  type AnyEvent = Event & Record<string, unknown>;
  const listen = (name: string, handler: (event: AnyEvent) => void) =>
    view.addEventListener(name, (event) => handler(event as AnyEvent));

  listen("did-attach", () => {
    id = safely(() => view.getWebContentsId(), null);
    if (id !== null) on.attach(id);
  });
  listen("dom-ready", () => {
    ready = true;
  });
  listen("did-start-navigation", (event) => {
    if (event.isMainFrame && !event.isInPlace) on.start(String(event.url));
  });
  listen("did-navigate", (event) => on.navigate(String(event.url), false));
  listen("did-navigate-in-page", (event) => {
    if (event.isMainFrame) on.navigate(String(event.url), true);
  });
  listen("did-start-loading", () => on.loading(true));
  listen("did-stop-loading", () => on.loading(false));
  listen("page-title-updated", (event) => on.title(String(event.title)));
  listen("page-favicon-updated", (event) => {
    const favicons = event.favicons as unknown;
    on.favicon(Array.isArray(favicons) && typeof favicons[0] === "string" ? favicons[0] : null);
  });
  listen("did-fail-load", (event) =>
    on.fail({
      errorCode: Number(event.errorCode),
      errorDescription: String(event.errorDescription ?? ""),
      validatedURL: String(event.validatedURL ?? ""),
      isMainFrame: event.isMainFrame !== false,
    }),
  );
  listen("render-process-gone", () => on.gone());
  listen("destroyed", () => {
    // Also fires when the element is removed on purpose; only a guest dying in place is a crash.
    if (view.isConnected && !destroyed) on.gone();
  });
  listen("devtools-opened", () => on.devtools(true));
  listen("devtools-closed", () => on.devtools(false));
  listen("media-started-playing", () => on.media(true));
  listen("media-paused", () => on.media(false));
  listen("focus", () => on.focus());
  listen("found-in-page", (event) => {
    const result = event.result as Partial<FindResult> | undefined;
    if (result && typeof result.matches === "number") {
      on.found({ activeMatchOrdinal: result.activeMatchOrdinal ?? 0, matches: result.matches });
    }
  });

  view.setAttribute("src", src);
  container.appendChild(view);

  const release = () => {
    if (document.activeElement !== view) return;
    view.blur();
    window.focus();
  };

  return {
    element: view,
    webContentsId: () => id,
    navigate: (url) => {
      if (!ready) {
        view.setAttribute("src", url);
        return;
      }
      // Failures arrive as did-fail-load; the promise only repeats them.
      safely(() => void view.loadURL(url).catch(() => {}), undefined);
    },
    back: () => safely(() => view.goBack(), undefined),
    forward: () => safely(() => view.goForward(), undefined),
    reload: () => safely(() => view.reload(), undefined),
    stop: () => safely(() => view.stop(), undefined),
    canGoBack: () => safely(() => view.canGoBack(), false),
    canGoForward: () => safely(() => view.canGoForward(), false),
    find: (text, next) =>
      safely(
        () =>
          void view.findInPage(text, next ? { forward: next.forward, findNext: true } : { findNext: false }),
        undefined,
      ),
    stopFind: () => safely(() => view.stopFindInPage("clearSelection"), undefined),
    zoom: () => safely(() => view.getZoomFactor(), 1),
    setZoom: (factor) => safely(() => view.setZoomFactor(factor), undefined),
    focus: () => safely(() => view.focus(), undefined),
    release,
    destroy: () => {
      if (destroyed) return;
      release();
      destroyed = true;
      view.remove();
    },
  };
}
