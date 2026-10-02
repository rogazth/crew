import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useHeldTabs } from "../hooks/useBrowserLeases";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { useDownloads } from "../hooks/useBrowserSignals";
import { useCommands } from "../hooks/useCommand";
import * as api from "../lib/api";
import { loadSitePermissions } from "../hooks/useSitePermissions";
import { downloads as downloadStore, isRunning } from "../lib/browser/downloads";
import { paneHandle } from "../lib/browser/handles";
import { leases } from "../lib/browser/leases";
import { pages } from "../lib/browser/pageStore";
import { prompts } from "../lib/browser/prompts";
import { liveGuests, touch } from "../lib/browser/retention";
import { browserHost } from "../lib/host";
import { newBrowserTab, paneId, type BrowserTabPatch } from "../lib/tabs";
import type { Tab } from "../lib/types";
import type { MountedPane } from "./WorkspacePanes";

/** The toolbar, the address bar and the guest wiring load with the first page, not with the window. */
const BrowserPane = lazy(() => import("./browser/BrowserPane").then((m) => ({ default: m.BrowserPane })));

type BrowserTab = Extract<Tab, { kind: "browser" }>;
type BrowserMount = MountedPane & { tab: BrowserTab };

type Props = {
  panes: MountedPane[];
  onPatch: (workspaceId: string, tabId: string, patch: BrowserTabPatch) => void;
  onOpenTab: (workspaceId: string, tab: Tab, opts: { after: string; background: boolean }) => void;
  onAdopt: (context: string, tab: Tab) => void;
};

const isBrowser = (pane: MountedPane): pane is BrowserMount => pane.tab.kind === "browser";

/**
 * Every open page stays mounted, shown or not, like the terminals: a guest
 * that leaves the DOM loses its page. Only the most recently shown ones keep
 * a live guest; the rest go cold until they are looked at again.
 */
export function Browsers({ panes, onPatch, onOpenTab, onAdopt }: Props) {
  const { prefs } = useBrowserPrefs();
  const browsers = panes.filter(isBrowser);
  const visible = browsers.find((pane) => pane.visible) ?? null;
  const visibleId = visible?.id ?? null;

  const [order, setOrder] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  if (shown !== visibleId) {
    setShown(visibleId);
    if (visibleId) setOrder((current) => touch(current, visibleId));
  }
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  // A page with a download in flight keeps its guest: discarding it would cancel the download.
  const downloading = new Set(
    useDownloads().flatMap((info) => (isRunning(info) && info.webContentsId !== null ? [info.webContentsId] : [])),
  );
  const downloads = browsers.flatMap((pane) => {
    const id = pages.get(pane.tab.id).webContentsId;
    return id !== null && downloading.has(id) ? [pane.id] : [];
  });
  const ids = new Set(browsers.map((pane) => pane.id));
  // An incognito page saved no stack to come back from, so going cold would lose it.
  const incognito = browsers.flatMap((pane) => (pane.tab.incognito ? [pane.id] : []));
  // A tab an agent drives stays live wherever it is, like one with DevTools open.
  const held = useHeldTabs();
  const driven = browsers.flatMap((pane) => (held.has(pane.tab.id) ? [pane.id] : []));
  const live = liveGuests({
    order: order.filter((id) => ids.has(id)),
    visible: visibleId,
    keep: prefs.keep,
    pinned: new Set([...pinned, ...downloads, ...incognito, ...driven].filter((id) => ids.has(id))),
  });

  const active = () => (visible ? paneHandle(visible.tab.id) : undefined);
  // Bound only while a page fills the active tab, so ⌘[ and ⌘R mean nothing anywhere else.
  useCommands(
    visible
      ? {
          "browser-back": () => active()?.back(),
          "browser-forward": () => active()?.forward(),
          "browser-reload": () => active()?.reload(),
          "browser-hard-reload": () => active()?.hardReload(),
          "browser-focus-address": () => active()?.focusAddress(),
          "browser-devtools": () => active()?.toggleDevTools(),
          find: () => active()?.find(),
          "zoom-in": () => active()?.zoom(1),
          "zoom-out": () => active()?.zoom(-1),
          "zoom-reset": () => active()?.zoom(0),
        }
      : {},
  );

  // A guest swallows every pointer event over it, so a drag that starts in the
  // app (the sidebar's edge, a sortable row) would stall the moment it crossed
  // a page. While a button is held, pages let the pointer through.
  const hasPages = browsers.length > 0;
  useEffect(() => {
    if (!hasPages) return;
    const root = document.documentElement;
    const hold = (event: PointerEvent) => {
      if (event.button === 0) root.classList.add("crew-dragging");
    };
    const release = () => root.classList.remove("crew-dragging");
    window.addEventListener("pointerdown", hold, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerdown", hold, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      release();
    };
  }, [hasPages]);

  // A closed tab's live state goes with it. Runs after the pane's own cleanup, which writes to it last.
  const known = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(browsers.map((pane) => pane.tab.id));
    for (const id of known.current) {
      if (now.has(id)) continue;
      pages.drop(id);
      // Closing a tab takes it back from whoever drives it, and it stops being
      // anyone's default: an agent's next call finds no tab rather than reopening it.
      void api.browserTabClosed(id).catch(() => {});
    }
    known.current = now;
  });

  const latest = useRef({ panes, browsers, visible, onOpenTab, onAdopt });
  useEffect(() => {
    latest.current = { panes, browsers, visible, onOpenTab, onAdopt };
  });

  // An agent needs a tab live: pinning it builds its guest, which reports
  // itself to main on attach. A tab the window does not hold yet (made by
  // open_tab, or in a workspace not shown since launch) joins its strip first.
  useEffect(
    () =>
      browserHost()?.onMount((request) => {
        leases.summon(request.tab);
        const pane = latest.current.browsers.find((p) => p.tab.id === request.tab);
        if (!pane) {
          latest.current.onAdopt(request.context, {
            id: request.tab,
            kind: "browser",
            url: request.url,
            title: request.title,
          });
          return;
        }
        // Main lost track of a guest that is still up (a window reload); tell it again.
        const id = pages.get(request.tab).webContentsId;
        if (id !== null) browserHost()?.reportGuest(request.tab, id);
      }),
    [],
  );
  useEffect(
    () =>
      browserHost()?.onOpenTab((request) => {
        const { panes: all, browsers: open, visible: front, onOpenTab: openTab } = latest.current;
        // A file's preview is no page of its own: its links open beside the tab on screen.
        const opener =
          open.find((pane) => pages.get(pane.tab.id).webContentsId === request.openerId) ??
          front ??
          all.find((pane) => pane.visible);
        if (!opener) return;
        const tab = newBrowserTab(request.url, request.incognito);
        openTab(opener.workspaceId, tab, { after: opener.tab.id, background: request.background });
        // A tab opened behind the current one still loads, the way a middle-click does.
        setOrder((current) => touch(current, paneId(opener.workspaceId, tab.id)));
      }),
    [],
  );

  // What main reports about the window's pages lands in the stores each page reads from.
  useEffect(() => {
    const host = browserHost();
    if (!host) return;
    void loadSitePermissions();
    const stops = [
      host.onDownload((info) => downloadStore.upsert(info)),
      host.onPrompt((prompt) => prompts.add(prompt)),
      host.onPromptGone((id) => prompts.remove(id)),
      host.onResponsive(({ webContentsId, hung }) => {
        const pane = latest.current.browsers.find((p) => pages.get(p.tab.id).webContentsId === webContentsId);
        if (pane) pages.update(pane.tab.id, { hung });
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  const askWhereToSave = prefs.askWhereToSave;
  useEffect(() => {
    browserHost()?.setAskWhereToSave(askWhereToSave);
  }, [askWhereToSave]);

  return browsers.map((pane) => {
    // A page an agent drives while you look elsewhere stays laid out, under
    // the pane on screen and behind a cover. A hidden guest draws nothing:
    // its screenshots never come, and clicks land on a page of no size.
    const staged = !pane.visible && held.has(pane.tab.id);
    return (
      <div
        key={pane.id}
        hidden={!pane.visible && !staged}
        inert={staged}
        aria-hidden={staged || undefined}
        className={staged ? "pointer-events-none absolute inset-0 -z-10" : "absolute inset-0"}
      >
        <Suspense fallback={null}>
          <BrowserPane
            pageId={pane.tab.id}
            workspaceId={pane.workspaceId}
            url={pane.tab.url}
            icon={pane.tab.icon ?? null}
            incognito={pane.tab.incognito === true}
            file={pane.tab.file ?? null}
            live={live.has(pane.id)}
            visible={pane.visible}
            searchTemplate={prefs.searchTemplate}
            onPatch={(patch) => onPatch(pane.workspaceId, pane.tab.id, patch)}
            onPinned={(on) =>
              setPinned((current) => {
                if (current.has(pane.id) === on) return current;
                const next = new Set(current);
                if (on) next.add(pane.id);
                else next.delete(pane.id);
                return next;
              })
            }
          />
        </Suspense>
        {staged && <div className="absolute inset-0 bg-canvas" />}
      </div>
    );
  });
}
