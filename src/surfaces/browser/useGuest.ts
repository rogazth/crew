import { useEffect, useRef, type RefObject } from "react";
import * as api from "../../lib/api";
import { partitionFor, RESTORE_PREFIX } from "../../lib/browser/bridge";
import { onMachine } from "../../lib/browser/machines";
import { classifyLoadFailure } from "../../lib/browser/loadError";
import { pages } from "../../lib/browser/pageStore";
import { isWebUrl, sameDocument } from "../../lib/browser/url";
import { openingSrc } from "../../lib/browser/opening";
import { FILES_PARTITION, isFileUrl, previewRoot } from "../../lib/browser/files";
import { createGuest, type Guest } from "../../lib/browser/webview";
import { browserHost, filesHost } from "../../lib/host";
import type { BrowserTabPatch } from "../../lib/tabs";
import type { AddressBarHandle } from "./AddressBar";

type Options = {
  pageId: string;
  /** What the tab restores to when the page has no saved stack. */
  url: string;
  /** The favicon the tab saved, shown while the page is cold. */
  icon: string | null;
  workspaceId: string;
  /**
   * The alias of the machine the workspace lives on: its pages' `localhost`
   * is that machine's. Null on this Mac; undefined while not known yet, and
   * the page waits for it.
   */
  machine: string | null | undefined;
  /** Opens in the in-memory session, and leaves no history, saved stack or cached icon behind. */
  incognito: boolean;
  /**
   * The file the page renders, in the previews' session instead of the
   * pages'. Like an incognito page it leaves no history or saved stack: its
   * URL is good for one run only.
   */
  file: { path: string; relative: string } | null;
  /** False when the retention budget has sent this page cold: no guest, nothing running. */
  live: boolean;
  /** Bumped to throw a dead guest away and build a new one. */
  generation: number;
  container: RefObject<HTMLDivElement | null>;
  address: RefObject<AddressBarHandle | null>;
  onPatch: (patch: BrowserTabPatch) => void;
  onPinned: (pinned: boolean) => void;
  onNavigate: (inPage: boolean) => void;
  onFound: (found: { index: number; count: number }) => void;
  /** The page took the keyboard: whatever floats over the toolbar closes, as a click outside would. */
  onFocus: () => void;
};

/** The page's guest, plus what only the pane knows about it. */
export type PageGuest = Guest & {
  /** DevTools docked in the pane report nothing through the guest, so the pane says so. */
  dockDevTools(docked: boolean): void;
};

/** A tab's title and URL are written this long after the page settles; a redirect chain is one write. */
const PATCH_MS = 500;
/** The back/forward stack is saved this long after the last navigation. */
const SNAPSHOT_MS = 2000;
/**
 * A saved stack that doesn't come back from the daemon by now isn't worth
 * waiting for. At launch the socket may still be connecting, and a short wait
 * there drops a restored stack to a single page.
 */
const RESTORE_WAIT_MS = 3000;

const fallbackSrc = (url: string) => (isWebUrl(url) ? url : "about:blank");

/** A page or a file: anything but the blank page, which shows the canvas underneath. */
const shows = (url: string) => isWebUrl(url) || isFileUrl(url);

const fileName = (relative: string) => relative.split("/").pop() || relative;

/** ERR_FILE_NOT_FOUND, for a file the scheme won't serve. */
const FILE_NOT_FOUND = -6;

/** The URL that serves the file this run, or null when it lies nowhere the scheme serves. */
async function fileSource(file: { path: string; relative: string }): Promise<string | null> {
  const host = filesHost();
  if (!host) return null;
  return host.url(previewRoot(file.path, file.relative), file.path).catch(() => null);
}

/** A restored tab asks main to rebuild its stack; a new one just loads its URL. */
async function source(pageId: string, url: string, machine: string | null): Promise<string> {
  const fallback = fallbackSrc(onMachine(url, machine));
  const host = browserHost();
  if (!host) return fallback;
  const saved = await Promise.race([
    api.browserPageGet(pageId).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_WAIT_MS)),
  ]);
  if (!saved) return fallback;
  const token = crypto.randomUUID();
  const ready = await host.prepareRestore(token, saved.entriesJson, saved.activeIndex, machine).catch(() => false);
  return ready ? `${RESTORE_PREFIX}${token}` : fallback;
}

/**
 * Builds the page's guest while it is live and turns its events into page
 * state, tab snapshots, history visits and saved stacks. Everything the build
 * reads is read through a ref: a navigation must never rebuild the guest.
 */
export function useGuest(options: Options): RefObject<PageGuest | null> {
  const { pageId, icon: savedIcon, machine, incognito, live, generation, container, address } = options;
  const filePath = options.file?.path ?? null;
  const guest = useRef<PageGuest | null>(null);
  // Read at build time only: a navigation must never rebuild the guest.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // A cold page that lost its live state (the window reloaded) shows the icon its tab saved.
  useEffect(() => {
    if (live || incognito || !savedIcon || pages.get(pageId).favicon) return;
    let cancelled = false;
    void browserHost()
      ?.favicon(savedIcon, false)
      .then((data) => {
        if (!cancelled && data && !pages.get(pageId).favicon) pages.update(pageId, { favicon: data });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [live, incognito, savedIcon, pageId]);

  useEffect(() => {
    // Every page signs in with the same cookies; an incognito one with its own, kept in memory.
    // A file has a session of its own, which holds none of the pages' sign-ins.
    const file = latest.current.file;
    const partition = file ? FILES_PARTITION : partitionFor(incognito);
    // Nothing of a file's page outlives the run, as nothing of an incognito one outlives the app.
    const ephemeral = incognito || file !== null;
    if (!live || machine === undefined) return;
    let cancelled = false;
    let built: Guest | null = null;
    let patchTimer: ReturnType<typeof setTimeout> | undefined;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: BrowserTabPatch = {};
    let recorded = "";
    let retried = false;
    let faviconAsk = 0;
    let devtools = false;
    let docked = false;
    let playing = false;

    const update = (patch: Parameters<typeof pages.update>[1]) => pages.update(pageId, patch);
    const patchTab = (patch: BrowserTabPatch) => {
      pending = { ...pending, ...patch };
      clearTimeout(patchTimer);
      patchTimer = setTimeout(() => {
        latest.current.onPatch(pending);
        pending = {};
      }, PATCH_MS);
    };
    const saveStack = () => {
      if (ephemeral) return;
      clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        const id = built?.webContentsId();
        const host = browserHost();
        if (id == null || !host) return;
        void host
          .snapshot(id)
          .then((snapshot) =>
            snapshot
              ? api.browserPageSave(pageId, JSON.stringify(snapshot.entries), snapshot.index)
              : undefined,
          )
          .catch(() => {});
      }, SNAPSHOT_MS);
    };
    const history = () => ({
      canGoBack: built?.canGoBack() ?? false,
      canGoForward: built?.canGoForward() ?? false,
    });
    const pin = () => latest.current.onPinned(devtools || docked || playing);

    // The bar is usable while source() waits on the daemon. A URL typed then is
    // kept here, and the guest is built as soon as one arrives instead of after
    // the wait. Focus asked for in that gap is applied once the page exists.
    let queued: string | null = null;
    let focusWhenReady = false;
    let notifyTyped: (() => void) | undefined;
    const typed = new Promise<void>((resolve) => {
      notifyTyped = resolve;
    });
    const facade: PageGuest = {
      get element() {
        if (!built) throw new Error("The page is not attached yet.");
        return built.element;
      },
      webContentsId: () => built?.webContentsId() ?? null,
      navigate: (typedUrl) => {
        // A remote workspace's `localhost` is its machine's, typed or clicked.
        const url = file ? typedUrl : onMachine(typedUrl, machine);
        if (built) {
          built.navigate(url);
          return;
        }
        queued = url;
        notifyTyped?.();
      },
      back: () => built?.back(),
      forward: () => built?.forward(),
      reload: () => built?.reload(),
      hardReload: () => built?.hardReload(),
      stop: () => built?.stop(),
      canGoBack: () => built?.canGoBack() ?? false,
      canGoForward: () => built?.canGoForward() ?? false,
      find: (text, next) => (next ? built?.find(text, next) : built?.find(text)),
      stopFind: () => built?.stopFind(),
      zoom: () => built?.zoom() ?? 1,
      setZoom: (factor) => built?.setZoom(factor),
      focus: () => {
        if (built) built.focus();
        else focusWhenReady = true;
      },
      release: () => built?.release(),
      destroy: () => built?.destroy(),
      dockDevTools: (on) => {
        docked = on;
        pin();
      },
    };
    guest.current = facade;

    void (async () => {
      if (file) {
        // The previews' session takes only its own scheme, so the guest is born at the file.
        const src = await fileSource(file);
        if (cancelled) return;
        if (!src) {
          update({
            error: { code: FILE_NOT_FOUND, description: "The file can't be shown.", url: file.path },
            loading: false,
          });
          return;
        }
        // A file's page is the file: a URL typed meanwhile is not its to load.
        queued = null;
        build({ src, restoring: false });
        return;
      }
      // A keystroke resolves `typed` and skips the rest of the wait. The fetch
      // still finishes; its token simply expires unused.
      // An incognito page saved no stack to restore.
      const opening = incognito
        ? Promise.resolve(fallbackSrc(onMachine(latest.current.url, machine)))
        : source(pageId, latest.current.url, machine);
      const restored = await Promise.race([opening, typed.then(() => null)]);
      if (cancelled) return;
      const open = openingSrc(restored, queued);
      queued = null;
      build(open);
    })();

    function build(open: { src: string; restoring: boolean }) {
      const host = container.current;
      if (cancelled || !host) return;
      // A restored stack re-commits its page; that is the same visit, not a new one.
      let restoring = open.restoring;
      built = createGuest(host, open.src, partition, {
        attach: (webContentsId) => {
          update({ webContentsId, crashed: false, hung: false });
          // Main finds a tab's page by this when an agent drives it.
          browserHost()?.reportGuest(pageId, webContentsId);
          browserHost()?.reportMachine?.(webContentsId, machine ?? null);
        },
        start: (next) => {
          const current = pages.get(pageId);
          // Chromium doesn't announce a favicon again on the same origin, so only a new origin clears it.
          const origin = (u: string) => (isWebUrl(u) ? new URL(u).origin : "");
          update({ error: null, ...(origin(next) !== origin(current.url) ? { favicon: null } : {}) });
        },
        navigate: (next, inPage) => {
          // Chromium keeps zoom per origin, so a new page may land at another one.
          update({ url: next, crashed: false, zoom: built?.zoom() ?? 1, ...history() });
          latest.current.onNavigate(inPage);
          // A blank page shows the canvas underneath, not the guest's white.
          if (built) built.element.style.visibility = shows(next) ? "" : "hidden";
          if (!isWebUrl(next)) return;
          patchTab({ url: next });
          saveStack();
          if (inPage && sameDocument(next, recorded)) return;
          recorded = next;
          if (restoring) {
            restoring = false;
            return;
          }
          if (!ephemeral) void api.browserHistoryVisit(next, "", latest.current.workspaceId).catch(() => {});
        },
        loading: (loading) => update({ loading, ...history() }),
        title: (title) => {
          const current = pages.get(pageId).url;
          if (file) {
            // Chromium names an untitled page after its URL, which says nothing a file's name doesn't.
            const named = !title || current.endsWith(title) ? fileName(file.relative) : title;
            update({ title: named });
            patchTab({ title: named });
            return;
          }
          update({ title });
          if (!isWebUrl(current)) return;
          patchTab({ title });
          if (!ephemeral) void api.browserHistoryTitle(current, title).catch(() => {});
        },
        favicon: (icon) => {
          const ask = ++faviconAsk;
          // A data URL can be large, and the tab is saved with every change: only a link is kept.
          if (!incognito && isWebUrl(pages.get(pageId).url)) patchTab({ icon: icon && isWebUrl(icon) ? icon : "" });
          if (!icon) return update({ favicon: null });
          void browserHost()
            ?.favicon(icon, incognito)
            .then((data) => {
              // A slow icon from the previous page must not land on this one, nor on a closed tab.
              if (ask === faviconAsk && !cancelled) update({ favicon: data });
            })
            .catch(() => {});
        },
        fail: (failure) => {
          const error = classifyLoadFailure(failure, pages.get(pageId).url);
          if (error) update({ error, loading: false });
        },
        gone: () => {
          update({ crashed: true, hung: false, loading: false });
          // One quiet retry: a renderer that died once usually comes back. The next commit clears the flag.
          if (retried) return;
          retried = true;
          built?.reload();
        },
        devtools: (open) => {
          devtools = open;
          update({ devtools: open });
          pin();
        },
        media: (on) => {
          playing = on;
          pin();
        },
        focus: () => {
          address.current?.dismiss();
          latest.current.onFocus();
        },
        found: ({ activeMatchOrdinal, matches }) =>
          latest.current.onFound({ index: Math.max(0, activeMatchOrdinal - 1), count: matches }),
      });
      // A second URL can land while the element is being created. It is a navigation, not a restore.
      let show = shows(open.src) || open.restoring;
      if (queued) {
        const extra = queued;
        queued = null;
        restoring = false;
        built.navigate(extra);
        show = isWebUrl(extra);
      }
      built.element.style.visibility = show ? "" : "hidden";
      if (focusWhenReady) built.focus();
    }

    return () => {
      cancelled = true;
      // A navigation still waiting to be saved is saved now, or ⌘⇧T brings back a stack without it.
      if (snapshotTimer !== undefined) {
        clearTimeout(snapshotTimer);
        const id = built?.webContentsId();
        const host = browserHost();
        if (id != null && host) {
          void host
            .snapshot(id)
            .then((snapshot) =>
              snapshot ? api.browserPageSave(pageId, JSON.stringify(snapshot.entries), snapshot.index) : undefined,
            )
            .catch(() => {});
        }
      }
      // A title or URL still waiting to be written is written now; the tab outlives its guest.
      clearTimeout(patchTimer);
      if (Object.keys(pending).length > 0) latest.current.onPatch(pending);
      built?.destroy();
      if (guest.current === facade) guest.current = null;
      if (devtools || docked || playing) latest.current.onPinned(false);
      update({ webContentsId: null, loading: false, devtools: false, hung: false });
    };
    // The file's path stands for it: the object is made afresh with every render.
  }, [live, pageId, machine, incognito, filePath, generation, container, address]);

  return guest;
}
