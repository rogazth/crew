import { useEffect, useRef, useState } from "react";
import { FindBar } from "../../chrome/FindBar";
import { useBrowserPage } from "../../hooks/useBrowserPage";
import { holdPane, type PaneHandle } from "../../lib/browser/handles";
import { pages } from "../../lib/browser/pageStore";
import { isWebUrl } from "../../lib/browser/url";
import { preset, type Viewport } from "../../lib/browser/viewport";
import { stepZoom } from "../../lib/browser/zoom";
import { browserHost } from "../../lib/host";
import { BrowserError } from "./BrowserError";
import { useGuest } from "./useGuest";
import { BrowserToolbar } from "./BrowserToolbar";
import { ResponsiveBar } from "./ResponsiveBar";
import type { AddressBarHandle } from "./AddressBar";

type Props = {
  pageId: string;
  workspaceId: string;
  /** What the tab restores to when the page has no saved stack. */
  url: string;
  live: boolean;
  visible: boolean;
  searchTemplate: string;
  onPatch: (patch: { url?: string; title?: string }) => void;
  /** DevTools open or audio playing: discarding the guest would lose what it's doing. */
  onPinned: (pinned: boolean) => void;
};

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
  // Bumped to throw a dead guest away and build a new one.
  const [generation, setGeneration] = useState(0);
  // The find bar: null while closed; the token re-selects the field on a second ⌘F.
  const [finding, setFinding] = useState<{ query: string; token: number } | null>(null);
  const [found, setFound] = useState({ index: 0, count: 0 });
  // A fixed page size to check a layout at; null fills the pane.
  const [viewport, setViewport] = useState<Viewport | null>(null);

  const guest = useGuest({
    pageId,
    url,
    workspaceId,
    live,
    generation,
    container,
    address,
    onPatch,
    onPinned,
    // Matches belong to the page they were found in.
    onNavigate: (inPage) => {
      if (inPage) return;
      setFinding(null);
      setFound({ index: 0, count: 0 });
    },
    onFound: setFound,
  });

  // Hiding a guest that holds focus makes macOS hand the keyboard to another app.
  // Showing one puts the keyboard where it's useful: the bar on a blank tab, else the page.
  useEffect(() => {
    if (!visible) {
      guest.current?.release();
      return;
    }
    if (isWebUrl(pages.get(pageId).url)) guest.current?.focus();
    else address.current?.focus();
  }, [visible, pageId, guest]);

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
    hardReload: () => {
      const error = pages.get(pageId).error;
      if (error) guest.current?.navigate(error.url);
      else guest.current?.hardReload();
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
        hardReload: () => current.current.hardReload(),
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
