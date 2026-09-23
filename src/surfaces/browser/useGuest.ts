import { useEffect, useRef, type RefObject } from "react";
import * as api from "../../lib/api";
import { RESTORE_PREFIX } from "../../lib/browser/bridge";
import { classifyLoadFailure } from "../../lib/browser/loadError";
import { pages } from "../../lib/browser/pageStore";
import { isWebUrl, sameDocument } from "../../lib/browser/url";
import { openingSrc } from "../../lib/browser/opening";
import { createGuest, type Guest } from "../../lib/browser/webview";
import { browserHost } from "../../lib/host";
import type { AddressBarHandle } from "./AddressBar";

type Options = {
  pageId: string;
  /** What the tab restores to when the page has no saved stack. */
  url: string;
  workspaceId: string;
  /** False when the retention budget has sent this page cold: no guest, nothing running. */
  live: boolean;
  /** Bumped to throw a dead guest away and build a new one. */
  generation: number;
  container: RefObject<HTMLDivElement | null>;
  address: RefObject<AddressBarHandle | null>;
  onPatch: (patch: { url?: string; title?: string }) => void;
  onPinned: (pinned: boolean) => void;
  onNavigate: (inPage: boolean) => void;
  onFound: (found: { index: number; count: number }) => void;
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

/** A restored tab asks main to rebuild its stack; a new one just loads its URL. */
async function source(pageId: string, url: string): Promise<string> {
  const fallback = isWebUrl(url) ? url : "about:blank";
  const host = browserHost();
  if (!host) return fallback;
  const saved = await Promise.race([
    api.browserPageGet(pageId).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), RESTORE_WAIT_MS)),
  ]);
  if (!saved) return fallback;
  const token = crypto.randomUUID();
  const ready = await host.prepareRestore(token, saved.entriesJson, saved.activeIndex).catch(() => false);
  return ready ? `${RESTORE_PREFIX}${token}` : fallback;
}

/**
 * Builds the page's guest while it is live and turns its events into page
 * state, tab snapshots, history visits and saved stacks. Everything the build
 * reads is read through a ref: a navigation must never rebuild the guest.
 */
export function useGuest(options: Options): RefObject<Guest | null> {
  const { pageId, live, generation, container, address } = options;
  const guest = useRef<Guest | null>(null);
  // Read at build time only: a navigation must never rebuild the guest.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let built: Guest | null = null;
    let patchTimer: ReturnType<typeof setTimeout> | undefined;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: { url?: string; title?: string } = {};
    let recorded = "";
    let retried = false;
    let faviconAsk = 0;
    let devtools = false;
    let playing = false;

    const update = (patch: Parameters<typeof pages.update>[1]) => pages.update(pageId, patch);
    const patchTab = (patch: { url?: string; title?: string }) => {
      pending = { ...pending, ...patch };
      clearTimeout(patchTimer);
      patchTimer = setTimeout(() => {
        latest.current.onPatch(pending);
        pending = {};
      }, PATCH_MS);
    };
    const saveStack = () => {
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
    const pin = () => latest.current.onPinned(devtools || playing);

    // The bar is usable while source() waits on the daemon. A URL typed then is
    // kept here, and the guest is built as soon as one arrives instead of after
    // the wait. Focus asked for in that gap is applied once the page exists.
    let queued: string | null = null;
    let focusWhenReady = false;
    let notifyTyped: (() => void) | undefined;
    const typed = new Promise<void>((resolve) => {
      notifyTyped = resolve;
    });
    const facade: Guest = {
      get element() {
        if (!built) throw new Error("The page is not attached yet.");
        return built.element;
      },
      webContentsId: () => built?.webContentsId() ?? null,
      navigate: (url) => {
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
    };
    guest.current = facade;

    void (async () => {
      // A keystroke resolves `typed` and skips the rest of the wait. The fetch
      // still finishes; its token simply expires unused.
      const restored = await Promise.race([source(pageId, latest.current.url), typed.then(() => null)]);
      const host = container.current;
      if (cancelled || !host) return;
      const open = openingSrc(restored, queued);
      queued = null;
      // A restored stack re-commits its page; that is the same visit, not a new one.
      let restoring = open.restoring;
      built = createGuest(host, open.src, {
        attach: (webContentsId) => update({ webContentsId, crashed: false }),
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
          if (built) built.element.style.visibility = isWebUrl(next) ? "" : "hidden";
          if (!isWebUrl(next)) return;
          patchTab({ url: next });
          saveStack();
          if (inPage && sameDocument(next, recorded)) return;
          recorded = next;
          if (restoring) {
            restoring = false;
            return;
          }
          void api.browserHistoryVisit(next, "", latest.current.workspaceId).catch(() => {});
        },
        loading: (loading) => update({ loading, ...history() }),
        title: (title) => {
          update({ title });
          const current = pages.get(pageId).url;
          if (!isWebUrl(current)) return;
          patchTab({ title });
          void api.browserHistoryTitle(current, title).catch(() => {});
        },
        favicon: (icon) => {
          const ask = ++faviconAsk;
          if (!icon) return update({ favicon: null });
          void browserHost()
            ?.favicon(icon)
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
          update({ crashed: true, loading: false });
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
        focus: () => address.current?.dismiss(),
        found: ({ activeMatchOrdinal, matches }) =>
          latest.current.onFound({ index: Math.max(0, activeMatchOrdinal - 1), count: matches }),
      });
      // A second URL can land while the element is being created. It is a navigation, not a restore.
      let show = isWebUrl(open.src) || open.restoring;
      if (queued) {
        const extra = queued;
        queued = null;
        restoring = false;
        built.navigate(extra);
        show = isWebUrl(extra);
      }
      built.element.style.visibility = show ? "" : "hidden";
      if (focusWhenReady) built.focus();
    })();

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
      if (pending.url !== undefined || pending.title !== undefined) latest.current.onPatch(pending);
      built?.destroy();
      if (guest.current === facade) guest.current = null;
      if (devtools || playing) latest.current.onPinned(false);
      update({ webContentsId: null, loading: false, devtools: false });
    };
  }, [live, pageId, generation, container, address]);

  return guest;
}
