import { useEffect, useRef, useState } from "react";
import { FindBar } from "../../chrome/FindBar";
import { useBrowserPage } from "../../hooks/useBrowserPage";
import * as api from "../../lib/api";
import { RESTORE_PREFIX } from "../../lib/browser/bridge";
import { holdPane, type PaneHandle } from "../../lib/browser/handles";
import { classifyLoadFailure } from "../../lib/browser/loadError";
import { pages } from "../../lib/browser/pageStore";
import { isWebUrl, sameDocument } from "../../lib/browser/url";
import { preset, type Viewport } from "../../lib/browser/viewport";
import { stepZoom } from "../../lib/browser/zoom";
import { createGuest, type Guest } from "../../lib/browser/webview";
import { browserHost } from "../../lib/host";
import { BrowserError } from "./BrowserError";
import { BrowserToolbar } from "./BrowserToolbar";
import { ResponsiveBar } from "./ResponsiveBar";
import type { AddressBarHandle } from "./AddressBar";

type Props = {
  pageId: string;
  workspaceId: string;
  /** What the tab restores to when the page has no saved stack. */
  url: string;
  /** False when the retention budget has sent this page cold: no guest, nothing running. */
  live: boolean;
  visible: boolean;
  searchTemplate: string;
  onPatch: (patch: { url?: string; title?: string }) => void;
  /** DevTools open or audio playing: discarding the guest would lose what it's doing. */
  onPinned: (pinned: boolean) => void;
};

/** A tab's title and URL are written this long after the page settles; a redirect chain is one write. */
const PATCH_MS = 500;
/** The back/forward stack is saved this long after the last navigation. */
const SNAPSHOT_MS = 2000;
/** A saved stack that doesn't come back from the daemon by now isn't worth waiting for. */
const RESTORE_WAIT_MS = 300;

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

export function BrowserPane({
  pageId,
  workspaceId,
  url,
  live,
  visible,
  searchTemplate,
  onPatch,
  onPinned,
}: Props) {
  const page = useBrowserPage(pageId);
  const container = useRef<HTMLDivElement>(null);
  const address = useRef<AddressBarHandle>(null);
  const guest = useRef<Guest | null>(null);
  // Bumped to throw a dead guest away and build a new one.
  const [generation, setGeneration] = useState(0);
  // The find bar: null while closed; the token re-selects the field on a second ⌘F.
  const [finding, setFinding] = useState<{ query: string; token: number } | null>(null);
  const [found, setFound] = useState({ index: 0, count: 0 });
  // A fixed page size to check a layout at; null fills the pane.
  const [viewport, setViewport] = useState<Viewport | null>(null);

  // Read at build time only: a navigation must never rebuild the guest.
  const latest = useRef({ url, workspaceId, onPatch, onPinned });
  useEffect(() => {
    latest.current = { url, workspaceId, onPatch, onPinned };
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

    void source(pageId, latest.current.url).then((src) => {
      const host = container.current;
      if (cancelled || !host) return;
      built = createGuest(host, src, {
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
          // Matches belong to the page they were found in.
          if (!inPage) {
            setFinding(null);
            setFound({ index: 0, count: 0 });
          }
          // A blank page shows the canvas underneath, not the guest's white.
          if (built) built.element.style.visibility = isWebUrl(next) ? "" : "hidden";
          if (!isWebUrl(next)) return;
          patchTab({ url: next });
          saveStack();
          if (inPage && sameDocument(next, recorded)) return;
          recorded = next;
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
              // A slow icon from the previous page must not land on this one.
              if (ask === faviconAsk) update({ favicon: data });
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
          setFound({ index: Math.max(0, activeMatchOrdinal - 1), count: matches }),
      });
      built.element.style.visibility = isWebUrl(src) || src.startsWith(RESTORE_PREFIX) ? "" : "hidden";
      guest.current = built;
    });

    return () => {
      cancelled = true;
      clearTimeout(snapshotTimer);
      // A title or URL still waiting to be written is written now; the tab outlives its guest.
      clearTimeout(patchTimer);
      if (pending.url !== undefined || pending.title !== undefined) latest.current.onPatch(pending);
      built?.destroy();
      if (guest.current === built) guest.current = null;
      if (devtools || playing) latest.current.onPinned(false);
      update({ webContentsId: null, loading: false, devtools: false });
    };
  }, [live, pageId, generation]);

  // Hiding a guest that holds focus makes macOS hand the keyboard to another app.
  // Showing one puts the keyboard where it's useful: the bar on a blank tab, else the page.
  useEffect(() => {
    if (!visible) {
      guest.current?.release();
      return;
    }
    if (isWebUrl(pages.get(pageId).url)) guest.current?.focus();
    else address.current?.focus();
  }, [visible, pageId]);

  const focusAddress = () => address.current?.focus();
  const handle: PaneHandle = {
    back: () => guest.current?.back(),
    forward: () => guest.current?.forward(),
    reload: () => {
      const error = pages.get(pageId).error;
      // After a failed load, reload() only refreshes Chromium's error page; go to the address again.
      if (error) guest.current?.navigate(error.url);
      else guest.current?.reload();
    },
    focusAddress,
    toggleDevTools: () => {
      const id = guest.current?.webContentsId();
      if (id != null) void browserHost()?.toggleDevTools(id);
    },
    navigate: (next) => {
      pages.update(pageId, { error: null });
      guest.current?.navigate(next);
      guest.current?.focus();
    },
    find: () => setFinding((open) => ({ query: open?.query ?? "", token: (open?.token ?? 0) + 1 })),
    zoom: (direction) => {
      const factor = stepZoom(pages.get(pageId).zoom, direction);
      guest.current?.setZoom(factor);
      pages.update(pageId, { zoom: factor });
    },
  };

  const search = (query: string) => {
    setFinding((open) => ({ query, token: open?.token ?? 0 }));
    if (query) guest.current?.find(query);
    else {
      guest.current?.stopFind();
      setFound({ index: 0, count: 0 });
    }
  };
  const closeFind = () => {
    guest.current?.stopFind();
    setFinding(null);
    setFound({ index: 0, count: 0 });
    guest.current?.focus();
  };
  // Held through a ref, so the registry keeps one entry per mount however often this renders.
  const current = useRef(handle);
  useEffect(() => {
    current.current = handle;
  });
  useEffect(
    () =>
      holdPane(pageId, {
        back: () => current.current.back(),
        forward: () => current.current.forward(),
        reload: () => current.current.reload(),
        focusAddress: () => current.current.focusAddress(),
        toggleDevTools: () => current.current.toggleDevTools(),
        navigate: (url) => current.current.navigate(url),
        find: () => current.current.find(),
        zoom: (direction) => current.current.zoom(direction),
      }),
    [pageId],
  );

  const restart = () => {
    pages.update(pageId, { crashed: false, error: null });
    setGeneration((n) => n + 1);
  };

  return (
    <div className="flex h-full flex-col bg-canvas">
      <BrowserToolbar
        page={page}
        addressRef={address}
        searchTemplate={searchTemplate}
        onBack={handle.back}
        onForward={handle.forward}
        onReload={handle.reload}
        onStop={() => guest.current?.stop()}
        onDevTools={handle.toggleDevTools}
        onZoomReset={() => handle.zoom(0)}
        responsive={viewport !== null}
        onResponsive={() => setViewport((current) => (current ? null : preset("phone")))}
        onNavigate={handle.navigate}
        onLeaveAddress={() => guest.current?.focus()}
      />
      {viewport && <ResponsiveBar viewport={viewport} onChange={setViewport} onClose={() => setViewport(null)} />}
      <div className={`relative min-h-0 flex-1 ${viewport ? "overflow-auto bg-sidebar" : ""}`}>
        {/* React never renders into this one: the guest is appended by hand and must never move.
            A fixed size restyles it in place; moving it into a frame would destroy the page. */}
        <div
          ref={container}
          className={viewport ? "relative mx-auto my-4 shrink-0 bg-canvas shadow-sm ring-1 ring-hairline" : "absolute inset-0"}
          style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
        />
        {finding && (
          <FindBar
            label="Find in page"
            query={finding.query}
            results={found}
            focusToken={finding.token}
            onQuery={search}
            onStep={(delta) => finding.query && guest.current?.find(finding.query, { forward: delta > 0 })}
            onClose={closeFind}
          />
        )}
        {page.crashed ? (
          <BrowserError kind="crash" onRetry={restart} />
        ) : (
          page.error && <BrowserError kind="load" error={page.error} onRetry={handle.reload} />
        )}
      </div>
    </div>
  );
}
