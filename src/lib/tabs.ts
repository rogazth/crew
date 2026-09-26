import { STUB_KINDS } from "./types";
import type { Session, StubKind, Tab } from "./types";

export const sessionTabId = (sessionId: string) => `session:${sessionId}`;
export const fileTabId = (path: string) => `file:${path}`;
export const stubTabId = (stub: StubKind) => `stub:${stub}`;
/** Unlike the other kinds, a page has no natural key: two tabs can show the same URL. */
export const browserTabId = () => `browser:${crypto.randomUUID()}`;

export function newBrowserTab(url = ""): Tab {
  return { id: browserTabId(), kind: "browser", url, title: "" };
}

/**
 * `recent` is the order tabs were last on screen in, newest first, so a
 * worktree can bring back the tab last used there. A strip saved before it
 * existed has none, and reads as its active tab, then the rightmost.
 */
export type TabState = {
  tabs: Tab[];
  activeId: string | null;
  closed: Tab[];
  recent?: string[];
  /** Worktrees whose tabs are folded into one chip, all together only. */
  collapsed?: string[];
};

/** Which tabs a strip shows; the ones folded into a chip are left out. */
export type Visible = (tab: Tab) => boolean;

export const NO_TABS: TabState = { tabs: [], activeId: null, closed: [] };

export const CLOSED_LIMIT = 10;

/**
 * Opens a tab, or focuses it if it is already open. `after` places it next to
 * the tab that asked for it, the way a link opened in a new tab lands beside
 * its page; `background` leaves the active tab alone.
 */
export function openTab(
  state: TabState,
  tab: Tab,
  { after, background = false }: { after?: string; background?: boolean } = {},
): TabState {
  const exists = state.tabs.some((t) => t.id === tab.id);
  let tabs = state.tabs;
  if (!exists) {
    // Pinned tabs lead the strip: a pinned one lands at their end, any other past them.
    const pins = pinnedCount(state.tabs);
    const anchor = after === undefined ? -1 : state.tabs.findIndex((t) => t.id === after);
    const at = tab.pinned
      ? pins
      : Math.max(pins, anchor === -1 ? state.tabs.length : anchor + 1);
    tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
  }
  const activeId = background && exists === false ? state.activeId : tab.id;
  return tabs === state.tabs && activeId === state.activeId ? state : { ...state, tabs, activeId };
}

/** A page committed a navigation or changed its title. Same state back when nothing moved. */
export function patchBrowserTab(
  state: TabState,
  id: string,
  patch: { url?: string; title?: string },
): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const tab = state.tabs[index];
  if (!tab || tab.kind !== "browser") return state;
  const url = patch.url ?? tab.url;
  const title = patch.title ?? tab.title;
  if (url === tab.url && title === tab.title) return state;
  const tabs = state.tabs.slice();
  tabs[index] = { ...tab, url, title };
  return { ...state, tabs };
}

function withoutTab(state: TabState, id: string, closed: Tab[], visible?: Visible): TabState {
  return {
    ...state,
    tabs: state.tabs.filter((t) => t.id !== id),
    activeId: state.activeId === id ? neighbourId(state.tabs, id, visible) : state.activeId,
    closed,
  };
}

export function closeTab(state: TabState, id: string, visible?: Visible): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  return withoutTab(state, id, [tab, ...state.closed].slice(0, CLOSED_LIMIT), visible);
}

/** Its session is gone, so the tab must not land in the reopen stack. */
export function closeSessionTab(state: TabState, sessionId: string): TabState {
  const tab = state.tabs.find((t) => t.kind === "session" && t.sessionId === sessionId);
  return tab ? withoutTab(state, tab.id, state.closed) : state;
}

export function reopenTab(state: TabState): TabState {
  const [tab, ...rest] = state.closed;
  if (!tab) return state;
  return openTab({ ...state, closed: rest }, tab);
}

/** Chromium's Ctrl+Tab: strip order, wrapping at both ends, past the tabs folded away. */
export function stepTab(state: TabState, delta: number, visible: Visible = () => true): TabState {
  const { activeId } = state;
  const tabs = state.tabs.filter((tab) => tab.id === activeId || visible(tab));
  if (tabs.length === 0) return state;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = (((index === -1 ? 0 : index + delta) % tabs.length) + tabs.length) % tabs.length;
  return { ...state, activeId: tabs[next]?.id ?? activeId };
}

/** Browser Cmd+1-8; Cmd+9 is the last tab, so pass -1. */
export function activateTab(state: TabState, index: number): TabState {
  const tab = index < 0 ? state.tabs.at(-1) : state.tabs[index];
  return tab && tab.id !== state.activeId ? { ...state, activeId: tab.id } : state;
}

export function selectTab(state: TabState, id: string | null): TabState {
  return state.activeId === id ? state : { ...state, activeId: id };
}

/**
 * The strip was dragged into a new order. An order that no longer names exactly
 * the open tabs is stale and dropped, and so is one that mixes the pinned in.
 */
export function reorderTabs(state: TabState, ids: string[]): TabState {
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs = ids.flatMap((id) => byId.get(id) ?? []);
  if (tabs.length !== state.tabs.length || new Set(ids).size !== ids.length) return state;
  if (pinnedCount(tabs) !== pinnedCount(state.tabs) || tabs.some((tab, at) => tab.pinned && at >= pinnedCount(tabs)))
    return state;
  return tabs.every((tab, index) => tab === state.tabs[index]) ? state : { ...state, tabs };
}

/** How many tabs lead the strip pinned. */
function pinnedCount(tabs: Tab[]): number {
  const at = tabs.findIndex((tab) => !tab.pinned);
  return at === -1 ? tabs.length : at;
}

/** Pinned first, each side in the order it had. */
export function pinnedFirst(tabs: Tab[]): Tab[] {
  const pinned = tabs.filter((tab) => tab.pinned);
  return pinned.length === pinnedCount(tabs) ? tabs : [...pinned, ...tabs.filter((tab) => !tab.pinned)];
}

/** Pins a tab after the ones already pinned, the way Chromium does. */
export function pinTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.pinned) return state;
  const rest = state.tabs.filter((t) => t.id !== id);
  const at = pinnedCount(rest);
  return { ...state, tabs: [...rest.slice(0, at), { ...tab, pinned: true }, ...rest.slice(at)] };
}

/** Unpins a tab to the head of the unpinned ones, right past the pinned. */
export function unpinTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab?.pinned) return state;
  const rest = state.tabs.filter((t) => t.id !== id);
  const at = pinnedCount(rest);
  const unpinned = { ...tab };
  delete unpinned.pinned;
  return { ...state, tabs: [...rest.slice(0, at), unpinned, ...rest.slice(at)] };
}

/** The tabs in the order they were last on screen, newest first; the ones never shown are left out. */
export function recentIds(state: TabState): string[] {
  const open = new Set(state.tabs.map((tab) => tab.id));
  const ids = [...(state.activeId ? [state.activeId] : []), ...(state.recent ?? [])];
  return ids.filter((id, at) => open.has(id) && ids.indexOf(id) === at);
}

/** `recent` brought up to date: the tab on screen first, and no tab that has closed. Same state back when it already is. */
export function withRecent(state: TabState): TabState {
  const recent = recentIds(state);
  const prior = state.recent ?? [];
  const same = recent.length === prior.length && recent.every((id, at) => id === prior[at]);
  return same ? state : { ...state, recent };
}

/** The tab last on screen of those `keep` takes, else the rightmost of them. */
export function lastUsed(state: TabState, keep: (tab: Tab) => boolean = () => true): Tab | null {
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  for (const id of recentIds(state)) {
    const tab = byId.get(id);
    if (tab && keep(tab)) return tab;
  }
  return [...state.tabs].reverse().find(keep) ?? null;
}

/**
 * After closing the active tab, focus its nearest shown neighbour, the right
 * one first; with none shown, the nearest folded one.
 */
function neighbourId(tabs: Tab[], closingId: string, visible: Visible = () => true): string | null {
  const index = tabs.findIndex((t) => t.id === closingId);
  if (index === -1) return null;
  const right = tabs.slice(index + 1);
  const left = tabs.slice(0, index).reverse();
  return (
    right.find(visible)?.id ?? left.find(visible)?.id ?? right[0]?.id ?? left[0]?.id ?? null
  );
}

/** Restores what `state_set` wrote. Anything that no longer parses is dropped, not thrown. */
export function parseTabs(raw: string | null): TabState {
  if (!raw) return NO_TABS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_TABS;
    const {
      tabs,
      activeId: savedActive,
      recent,
      collapsed,
    } = parsed as { tabs?: unknown; activeId?: unknown; recent?: unknown; collapsed?: unknown };
    if (!Array.isArray(tabs)) return NO_TABS;
    let activeId = savedActive;
    const kept = pinnedFirst(
      tabs.flatMap((value: unknown) => {
        if (!isLegacyBrowserStub(value)) return isTab(value) ? [value] : [];
        // The browser used to be a placeholder stub; it comes back as a blank page.
        const tab = newBrowserTab();
        if (activeId === value.id) activeId = tab.id;
        return [tab];
      }),
    );
    const open = new Set(kept.map((tab) => tab.id));
    return {
      tabs: kept,
      activeId: kept.some((tab) => tab.id === activeId) ? (activeId as string) : (kept[0]?.id ?? null),
      closed: [],
      ...(Array.isArray(recent) && {
        recent: recent.filter((id): id is string => typeof id === "string" && open.has(id)),
      }),
      ...(Array.isArray(collapsed) &&
        collapsed.length > 0 && {
          collapsed: collapsed.filter((place): place is string => typeof place === "string"),
        }),
    };
  } catch {
    return NO_TABS;
  }
}

function isLegacyBrowserStub(value: unknown): value is { id: string } {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as { id?: unknown; kind?: unknown; stub?: unknown };
  return tab.kind === "stub" && tab.stub === "browser" && typeof tab.id === "string";
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Partial<Tab>;
  if (typeof tab.id !== "string") return false;
  if (tab.pinned !== undefined && tab.pinned !== true) return false;
  if (tab.kind === "session") return typeof tab.sessionId === "string";
  if (tab.kind === "file") return typeof tab.path === "string" && typeof tab.relative === "string";
  if (tab.kind === "browser")
    return tab.id.startsWith("browser:") && typeof tab.url === "string" && typeof tab.title === "string";
  if (tab.kind === "stub")
    return (
      typeof tab.title === "string" && STUB_KINDS.includes(tab.stub as StubKind)
    );
  return false;
}

export function isAgentTab(tab: Tab | null, sessions: Session[]): boolean {
  if (!tab || tab.kind !== "session") return false;
  return sessions.find((session) => session.id === tab.sessionId)?.kind === "agent";
}

/** Which tab the terminal commands aim at. */
export function isTerminalTab(tab: Tab | null, sessions: Session[]): boolean {
  if (!tab) return false;
  if (tab.kind === "stub") return tab.stub === "terminal";
  if (tab.kind !== "session") return false;
  return sessions.find((session) => session.id === tab.sessionId)?.kind === "terminal";
}

/** A path the terminal linked is absolute; a file tab labels itself with the short form. */
export function relativeTo(root: string, path: string): string {
  const base = root.replace(/\/$/, "");
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

export function tabTitle(tab: Tab, sessions: Session[]): string {
  if (tab.kind === "stub") return tab.title;
  if (tab.kind === "browser") return browserTitle(tab.title, tab.url);
  if (tab.kind === "file") return tab.relative.split("/").pop() ?? tab.relative;
  return sessions.find((s) => s.id === tab.sessionId)?.name ?? "Untitled";
}

/** What a page tab reads: its title, else its host, else what a blank tab is called. */
export function browserTitle(title: string, url: string): string {
  if (title.trim()) return title;
  try {
    const { protocol, host } = new URL(url);
    if ((protocol === "http:" || protocol === "https:") && host) return host;
  } catch {
    // Not a URL yet: a blank tab.
  }
  return "New Tab";
}

/** Every workspace whose tabs this window has restored, not just the one on screen. */
export type TabRegistry = Record<string, TabState>;

/**
 * A pane outlives the workspace switch that hides it, so two workspaces can
 * hold a tab of the same id — `stub:terminal` does — and the pty behind it is
 * keyed by this, not by the tab.
 */
export const paneId = (workspaceId: string, tabId: string) => `${workspaceId}/${tabId}`;

export type Pane = { id: string; workspaceId: string; tab: Tab; visible: boolean };

/** Every open tab of every restored workspace. Only one of them is on screen. */
export function panesOf(registry: TabRegistry, activeWorkspaceId: string | null): Pane[] {
  return Object.entries(registry).flatMap(([workspaceId, state]) =>
    state.tabs.map((tab) => ({
      id: paneId(workspaceId, tab.id),
      workspaceId,
      tab,
      visible: workspaceId === activeWorkspaceId && tab.id === state.activeId,
    })),
  );
}
