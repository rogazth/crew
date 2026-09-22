import { STUB_KINDS } from "./types";
import type { Session, StubKind, Tab } from "./types";

export const sessionTabId = (sessionId: string) => `session:${sessionId}`;
export const fileTabId = (path: string) => `file:${path}`;
export const stubTabId = (stub: StubKind) => `stub:${stub}`;

export type TabState = { tabs: Tab[]; activeId: string | null; closed: Tab[] };

export const NO_TABS: TabState = { tabs: [], activeId: null, closed: [] };

const CLOSED_LIMIT = 10;

export function openTab(state: TabState, tab: Tab): TabState {
  const tabs = state.tabs.some((t) => t.id === tab.id) ? state.tabs : [...state.tabs, tab];
  return { ...state, tabs, activeId: tab.id };
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
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs)) return NO_TABS;
    const kept = tabs.filter(isTab);
    return {
      tabs: kept,
      activeId: kept.some((tab) => tab.id === activeId) ? (activeId as string) : (kept[0]?.id ?? null),
      closed: [],
    };
  } catch {
    return NO_TABS;
  }
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Partial<Tab>;
  if (typeof tab.id !== "string") return false;
  if (tab.kind === "session") return typeof tab.sessionId === "string";
  if (tab.kind === "file") return typeof tab.path === "string" && typeof tab.relative === "string";
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
  if (tab.kind === "file") return tab.relative.split("/").pop() ?? tab.relative;
  return sessions.find((s) => s.id === tab.sessionId)?.name ?? "Untitled";
}
