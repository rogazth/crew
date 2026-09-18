import type { StubKind, Tab } from "@crew/fixtures";

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
  return openTab({ ...state, closed: rest }, tab);
}

/** Strip order, wrapping at both ends. */
export function stepTab(state: TabState, delta: number): TabState {
  const { tabs, activeId } = state;
  if (tabs.length === 0) return state;
  const index = tabs.findIndex((tab) => tab.id === activeId);
  const next = (((index === -1 ? 0 : index + delta) % tabs.length) + tabs.length) % tabs.length;
  return { ...state, activeId: tabs[next]?.id ?? activeId };
}

export function tabAt(state: TabState, index: number): TabState {
  const tab = state.tabs[index];
  return tab ? { ...state, activeId: tab.id } : state;
}

export const activeTab = (state: TabState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeId) ?? null;
