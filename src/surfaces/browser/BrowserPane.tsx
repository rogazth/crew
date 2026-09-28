import { useEffect, useRef, useState } from "react";
import { FindBar } from "../../chrome/FindBar";
import { useLease } from "../../hooks/useBrowserLeases";
import { useBrowserPage } from "../../hooks/useBrowserPage";
import * as api from "../../lib/api";
import { useBrowserPrefs } from "../../hooks/useBrowserPrefs";
import { holdPane, type PaneHandle } from "../../lib/browser/handles";
import { BLANK_PAGE, pages, type PageState } from "../../lib/browser/pageStore";
import { originOf } from "../../lib/browser/permissions";
import { isWebUrl } from "../../lib/browser/url";
import { preset, type Viewport } from "../../lib/browser/viewport";
import { stepZoom } from "../../lib/browser/zoom";
import type { DevToolsDock } from "../../lib/browserPrefs";
import { runCommand } from "../../lib/commands";
import { browserHost, type BrowserHost } from "../../lib/host";
import type { CookieSource } from "../../lib/protocol";
import { BrowserError } from "./BrowserError";
import { useGuest } from "./useGuest";
import { BrowserToolbar, type ToolbarPanel } from "./BrowserToolbar";
import { DrivenBar } from "./DrivenBar";
import { PagePrompts } from "./PagePrompt";
import { CookieImportDialog } from "./CookieImportDialog";
import { DevToolsPanel } from "./DevToolsPanel";
import { ResponsiveBar } from "./ResponsiveBar";
import { ViewportHandles } from "./ViewportHandles";
import type { BrowserTabPatch } from "../../lib/tabs";
import type { AddressBarHandle } from "./AddressBar";

/** How the page and docked DevTools share the pane: the page always comes first in the DOM. */
const FLOW: Record<Exclude<DevToolsDock, "window">, string> = {
  right: "flex-row",
  bottom: "flex-col",
  left: "flex-row-reverse",
};

type Props = {
  pageId: string;
  workspaceId: string;
  /** What the tab restores to when the page has no saved stack. */
  url: string;
  /** The favicon the tab saved, shown while the page is cold. */
  icon: string | null;
  incognito: boolean;
  live: boolean;
  visible: boolean;
  searchTemplate: string;
  onPatch: (patch: BrowserTabPatch) => void;
  /** DevTools open or audio playing: discarding the guest would lose what it's doing. */
  onPinned: (pinned: boolean) => void;
};

export function BrowserPane({
  pageId,
  workspaceId,
  url,
  icon,
  incognito,
  live,
  visible,
  searchTemplate,
  onPatch,
  onPinned,
}: Props) {
  const page = useBrowserPage(pageId);
  const lease = useLease(pageId);
  const { prefs, update: updatePrefs } = useBrowserPrefs();
  const container = useRef<HTMLDivElement>(null);
  const address = useRef<AddressBarHandle>(null);
  // Bumped to throw a dead guest away and build a new one.
  const [generation, setGeneration] = useState(0);
  // The find bar: null while closed; the token re-selects the field on a second ⌘F.
  const [finding, setFinding] = useState<{ query: string; token: number } | null>(null);
  const [found, setFound] = useState({ index: 0, count: 0 });
  // A fixed page size to check a layout at; null fills the pane.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  // The profile whose cookies the import dialog is asking about.
  const [importing, setImporting] = useState<CookieSource | null>(null);
  const [panel, onPanel, closePanel] = useToolbarPanel(visible);

  // The guest whose DevTools are docked in the pane. A rebuilt guest has another id, so it starts without them.
  const [dockedFor, setDockedFor] = useState<number | null>(null);
  const docked = dockedFor !== null && dockedFor === page.webContentsId;
  // A move to a window is under way while the panel is still up; it keeps its side meanwhile.
  const side = prefs.devtoolsDock === "window" ? "bottom" : prefs.devtoolsDock;

  const guest = useGuest({
    pageId,
    url,
    icon,
    workspaceId,
    incognito,
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
    // A click into the page never reaches the window's DOM, so the panels can't see it as a click outside.
    onFocus: closePanel,
  });

  // What the tab opened with, read until the guest reports its own URL.
  const initialUrl = useRef(url);
  // Hiding a guest that holds focus makes macOS hand the keyboard to another app.
  // Showing one puts the keyboard where it's useful: the bar on a blank tab, else the page.
  useEffect(() => {
    if (!visible) {
      guest.current?.release();
      return;
    }
    // A tab opened with a URL shows before its guest reports one; the store still says blank.
    const current = pages.get(pageId);
    const shown = current === BLANK_PAGE ? initialUrl.current : current.url;
    if (isWebUrl(shown)) guest.current?.focus();
    else address.current?.focus();
  }, [visible, pageId, guest]);

  const focusAddress = () => address.current?.focus();
  // Docked DevTools keep the page from being discarded, as ones in a window do.
  const setDocked = (id: number | null) => {
    setDockedFor(id);
    guest.current?.dockDevTools(id !== null);
  };
  // Main lets docked DevTools go before anything else opens them, or a window of their own would close too.
  const undock = async (host: BrowserHost, id: number) => {
    await host.closeDevTools(id).catch(() => {});
    setDocked(null);
  };
  const moveDevTools = (dock: DevToolsDock) => {
    updatePrefs({ ...prefs, devtoolsDock: dock });
    const id = guest.current?.webContentsId();
    const host = browserHost();
    if (id == null || !host) return;
    if (dock === "window" && docked) {
      void undock(host, id).then(() => host.toggleDevTools(id));
    } else if (dock !== "window" && !docked && pages.get(pageId).devtools) {
      // Main closes the window they are in as it docks them.
      setDocked(id);
    }
  };
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
      const host = browserHost();
      if (id == null || !host) return;
      if (docked) {
        void undock(host, id).then(() => guest.current?.focus());
      } else if (prefs.devtoolsDock === "window" || pages.get(pageId).devtools) {
        void host.toggleDevTools(id);
      } else {
        setDocked(id);
      }
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
    pages.update(pageId, { crashed: false, hung: false, error: null });
    setGeneration((n) => n + 1);
  };
  const reloadHung = () => void endProcess(guest.current?.webContentsId()).then(restart);
  const site = incognito ? null : originOf(page.url);

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
        devtools={docked || page.devtools}
        devtoolsDock={prefs.devtoolsDock}
        onDevToolsDock={moveDevTools}
        onZoom={handle.zoom}
        onFind={handle.find}
        onHistory={() => runCommand("open-history")}
        onSettings={() => runCommand("open-browser-settings")}
        onPrint={() => printPage(guest.current?.webContentsId())}
        onImportCookies={setImporting}
        // Imported cookies go to the workspace's saved session, which an incognito page never sees.
        canImport={browserHost() !== null && !incognito}
        site={site}
        panel={panel}
        onPanel={onPanel}
        incognito={incognito}
        responsive={viewport !== null}
        onResponsive={() => setViewport((current) => (current ? null : preset("phone")))}
        onNavigate={handle.navigate}
        onLeaveAddress={() => guest.current?.focus()}
      />
      {lease && lease.sessionId && (
        <DrivenBar lease={lease} onTakeBack={() => void api.browserLeaseRelease(pageId).catch(() => {})} />
      )}
      <div className={`flex min-h-0 flex-1 ${FLOW[side]}`}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {viewport && <ResponsiveBar viewport={viewport} onChange={setViewport} onClose={() => setViewport(null)} />}
          <div className={`relative min-h-0 flex-1 ${viewport ? "grid overflow-auto bg-sidebar px-6 pt-4 pb-6" : ""}`}>
            {/* React never renders into this one: the guest is appended by hand and must never move.
                A fixed size restyles it in place; moving it into a frame would destroy the page. */}
            <div
              ref={container}
              className={
                viewport
                  ? "relative self-start justify-self-center bg-canvas shadow-sm ring-1 ring-hairline [grid-area:1/1]"
                  : "absolute inset-0"
              }
              style={viewport ? { width: viewport.width, height: viewport.height } : undefined}
            />
            {viewport && <ViewportHandles viewport={viewport} onChange={setViewport} />}
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
            <PageCover
              page={page}
              onRestart={restart}
              onReload={handle.reload}
              onReloadHung={reloadHung}
              onWait={() => pages.update(pageId, { hung: false })}
            />
            <PagePrompts
              webContentsId={page.webContentsId}
              incognito={incognito}
              onSignedIn={() => guest.current?.focus()}
            />
          </div>
        </div>
        {docked && (
          <DevToolsPanel
            guestId={dockedFor}
            dock={side}
            size={side === "bottom" ? prefs.devtoolsHeight : prefs.devtoolsWidth}
            visible={visible}
            onResize={(size) =>
              updatePrefs(side === "bottom" ? { ...prefs, devtoolsHeight: size } : { ...prefs, devtoolsWidth: size })
            }
            onFailed={() => setDocked(null)}
            onClose={handle.toggleDevTools}
          />
        )}
      </div>
      <CookieImportDialog
        source={importing}
        workspaceId={workspaceId}
        onClose={() => {
          setImporting(null);
          guest.current?.focus();
        }}
        // The page on screen was loaded signed out; show it with the new cookies.
        onImported={() => {
          if (isWebUrl(pages.get(pageId).url)) handle.reload();
        }}
      />
    </div>
  );
}

/** What covers the page when it can't be shown: its process died, it stopped answering, or it didn't load. */
function PageCover({
  page,
  onRestart,
  onReload,
  onReloadHung,
  onWait,
}: {
  page: PageState;
  onRestart: () => void;
  onReload: () => void;
  onReloadHung: () => void;
  onWait: () => void;
}) {
  if (page.crashed) return <BrowserError kind="crash" onRetry={onRestart} />;
  if (page.hung) return <BrowserError kind="hung" onRetry={onReloadHung} onWait={onWait} />;
  if (page.error) return <BrowserError kind="load" error={page.error} onRetry={onReload} />;
  return null;
}

/**
 * The menu or the downloads list, one at a time. Both float in a portal
 * outside the pane, so hiding the pane doesn't hide them: a tab switched away
 * from with the keyboard closes them here. Closing one never closes the other,
 * whichever order their events come in.
 */
function useToolbarPanel(visible: boolean) {
  const [panel, setPanel] = useState<ToolbarPanel | null>(null);
  if (!visible && panel !== null) setPanel(null);
  const onPanel = (which: ToolbarPanel, open: boolean) =>
    setPanel((current) => (open ? which : current === which ? null : current));
  const close = () => setPanel(null);
  return [panel, onPanel, close] as const;
}

/** A hung process ignores a reload, so it is ended first; resolves once it is gone, or couldn't be. */
async function endProcess(id: number | null | undefined): Promise<void> {
  if (id == null) return;
  await browserHost()?.kill(id).catch(() => {});
}

function printPage(id: number | null | undefined): void {
  if (id != null) void browserHost()?.print(id).catch(() => {});
}
