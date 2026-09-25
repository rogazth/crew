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

export type TabState = { tabs: Tab[]; activeId: string | null; closed: Tab[] };

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
    const anchor = after === undefined ? -1 : state.tabs.findIndex((t) => t.id === after);
    tabs =
      anchor === -1
        ? [...state.tabs, tab]
        : [...state.tabs.slice(0, anchor + 1), tab, ...state.tabs.slice(anchor + 1)];
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

function withoutTab(state: TabState, id: string, closed: Tab[]): TabState {
  return {
    tabs: state.tabs.filter((t) => t.id !== id),
    activeId: state.activeId === id ? neighbourId(state.tabs, id) : state.activeId,
    closed,
  };
}

export function closeTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  return withoutTab(state, id, [tab, ...state.closed].slice(0, CLOSED_LIMIT));
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

/** Chromium's Ctrl+Tab: strip order, wrapping at both ends. */
export function stepTab(state: TabState, delta: number): TabState {
  const { tabs, activeId } = state;
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

/** The strip was dragged into a new order. An order that no longer names exactly the open tabs is stale and dropped. */
export function reorderTabs(state: TabState, ids: string[]): TabState {
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const tabs = ids.flatMap((id) => byId.get(id) ?? []);
  if (tabs.length !== state.tabs.length || new Set(ids).size !== ids.length) return state;
  return tabs.every((tab, index) => tab === state.tabs[index]) ? state : { ...state, tabs };
}

/** After closing the active tab, focus its right neighbour, else its left one. */
function neighbourId(tabs: Tab[], closingId: string): string | null {
  const index = tabs.findIndex((t) => t.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

/** Restores what `state_set` wrote. Anything that no longer parses is dropped, not thrown. */
export function parseTabs(raw: string | null): TabState {
  if (!raw) return NO_TABS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_TABS;
    const { tabs, activeId: savedActive } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs)) return NO_TABS;
    let activeId = savedActive;
    const kept = tabs.flatMap((value: unknown) => {
      if (!isLegacyBrowserStub(value)) return isTab(value) ? [value] : [];
      // The browser used to be a placeholder stub; it comes back as a blank page.
      const tab = newBrowserTab();
      if (activeId === value.id) activeId = tab.id;
      return [tab];
    });
    return {
      tabs: kept,
      activeId: kept.some((tab) => tab.id === activeId) ? (activeId as string) : (kept[0]?.id ?? null),
      closed: [],
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
