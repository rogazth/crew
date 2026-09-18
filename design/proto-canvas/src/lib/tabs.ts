import type { Session, StubKind, Tab } from "@crew/fixtures";

export const sessionTabId = (sessionId: string) => `session:${sessionId}`;
export const fileTabId = (path: string) => `file:${path}`;
export const stubTabId = (stub: StubKind) => `stub:${stub}`;

export type TabState = { tabs: Tab[]; activeId: string | null; closed: Tab[] };

export const NO_TABS: TabState = { tabs: [], activeId: null, closed: [] };

const CLOSED_LIMIT = 10;

export const sessionTab = (session: Session): Tab => ({
  id: sessionTabId(session.id),
  kind: "session",
  sessionId: session.id,
});

export function openTab(state: TabState, tab: Tab): TabState {
  const tabs = state.tabs.some((t) => t.id === tab.id) ? state.tabs : [...state.tabs, tab];
  return { ...state, tabs, activeId: tab.id };
}

/** After closing the active tab, focus its right neighbour, else its left one. */
function neighbourId(tabs: Tab[], closingId: string): string | null {
  const index = tabs.findIndex((t) => t.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

export function closeTab(state: TabState, id: string): TabState {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  return {
    tabs: state.tabs.filter((t) => t.id !== id),
    activeId: state.activeId === id ? neighbourId(state.tabs, id) : state.activeId,
    closed: [tab, ...state.closed].slice(0, CLOSED_LIMIT),
  };
}

export function reopenTab(state: TabState): TabState {
  const [tab, ...rest] = state.closed;
  if (!tab) return state;
  return { ...openTab({ ...state, closed: rest }, tab) };
}

/** Chromium's Ctrl+Tab: strip order, wrapping at both ends. */
export function stepTab(state: TabState, delta: number): TabState {
  const { tabs, activeId } = state;
  if (tabs.length === 0) return state;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = (((index === -1 ? 0 : index + delta) % tabs.length) + tabs.length) % tabs.length;
  return { ...state, activeId: tabs[next]?.id ?? activeId };
}

export function moveTab(state: TabState, from: number, to: number): TabState {
  if (from === to || from < 0 || to < 0 || from >= state.tabs.length || to >= state.tabs.length) {
    return state;
  }
  const tabs = state.tabs.slice();
  const [moved] = tabs.splice(from, 1);
  if (!moved) return state;
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}
