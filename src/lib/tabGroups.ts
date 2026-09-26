import { lastUsed, type TabState, type Visible } from "./tabs";
import type { Tab } from "./types";

/**
 * All together, a worktree's tabs can fold into one chip on the strip. They are
 * never kept side by side otherwise: folding gathers them where the fold was
 * asked for, and they unfold there, their old places gone.
 */

/** The worktree a tab belongs to, or null for one of none: pages and the like. */
export type PlaceOf = (tab: Tab) => string | null;

/** A worktree's unpinned tabs; the pinned never fold. */
function members(tabs: Tab[], place: string, placeOf: PlaceOf): Tab[] {
  return tabs.filter((tab) => !tab.pinned && placeOf(tab) === place);
}

/** Whether a tab shows: a pinned one always does, any other unless its worktree is folded. */
export function visibleIn(state: TabState, placeOf: PlaceOf | null): Visible {
  if (!placeOf || !state.collapsed?.length) return () => true;
  const folded = new Set(state.collapsed);
  return (tab) => {
    if (tab.pinned) return true;
    const place = placeOf(tab);
    return place === null || !folded.has(place);
  };
}

/** `group` side by side where `at` stood, in their own order; the rest keep theirs. */
function gather(tabs: Tab[], group: Tab[], at: string): Tab[] {
  const ids = new Set(group.map((tab) => tab.id));
  const out = tabs.flatMap((tab) => (tab.id === at ? group : ids.has(tab.id) ? [] : [tab]));
  return out.length === tabs.length && out.every((tab, index) => tab === tabs[index]) ? tabs : out;
}

/** Folded worktrees that still hold a tab; the rest have nothing to fold. */
function held(state: TabState, placeOf: PlaceOf): string[] {
  const places = new Set(state.tabs.flatMap((tab) => (tab.pinned ? [] : [placeOf(tab) ?? ""])));
  return (state.collapsed ?? []).filter((place) => places.has(place));
}

function withCollapsed(state: TabState, collapsed: string[]): TabState {
  const next: TabState = { ...state, collapsed };
  if (!collapsed.length) delete next.collapsed;
  return next;
}

/**
 * Folds `place`'s tabs into a chip standing where `at` did. The tab on screen
 * gives way to the last one used that still shows; with none left, nothing folds.
 */
export function collapseGroup(state: TabState, place: string, at: string, placeOf: PlaceOf): TabState {
  const group = members(state.tabs, place, placeOf);
  if (group.length === 0 || state.collapsed?.includes(place)) return state;
  const anchor = group.some((tab) => tab.id === at) ? at : group[0]!.id;
  const next = withCollapsed(
    { ...state, tabs: gather(state.tabs, group, anchor) },
    [...held(state, placeOf), place],
  );
  const visible = visibleIn(next, placeOf);
  const active = next.tabs.find((tab) => tab.id === state.activeId);
  if (!active || visible(active)) return next;
  const other = lastUsed(next, visible);
  return other ? { ...next, activeId: other.id } : state;
}

/** Folds every worktree but `place`, each where its first tab stood. */
export function collapseOthers(state: TabState, place: string, placeOf: PlaceOf): TabState {
  const places = new Set(state.tabs.flatMap((tab) => (tab.pinned ? [] : [placeOf(tab) ?? place])));
  places.delete(place);
  let next = state;
  for (const other of places) {
    const first = members(next.tabs, other, placeOf)[0];
    if (first) next = collapseGroup(next, other, first.id, placeOf);
  }
  return next;
}

/** Unfolds `place`'s tabs where its chip stood. */
export function expandGroup(state: TabState, place: string, placeOf: PlaceOf): TabState {
  if (!state.collapsed?.includes(place)) return state;
  const group = members(state.tabs, place, placeOf);
  const tabs = group[0] ? gather(state.tabs, group, group[0].id) : state.tabs;
  return withCollapsed({ ...state, tabs }, held(state, placeOf).filter((other) => other !== place));
}

/** A tab brought on screen from anywhere unfolds its worktree: the strip never hides the tab you are on. */
export function revealActive(state: TabState, placeOf: PlaceOf): TabState {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  if (!active || visibleIn(state, placeOf)(active)) return state;
  return expandGroup(state, placeOf(active)!, placeOf);
}

export type StripItem = { kind: "tab"; tab: Tab } | { kind: "group"; id: string; place: string; tabs: Tab[] };

export const groupItemId = (place: string) => `group:${place}`;

/** The strip as drawn: each folded worktree is one chip, where its first tab stands. */
export function stripItems(tabs: Tab[], collapsed: string[], placeOf: PlaceOf | null): StripItem[] {
  if (!placeOf || collapsed.length === 0) return tabs.map((tab) => ({ kind: "tab", tab }));
  const folded = new Set(collapsed);
  const groups = new Map<string, Tab[]>();
  const items: StripItem[] = [];
  for (const tab of tabs) {
    const place = tab.pinned ? null : placeOf(tab);
    if (place === null || !folded.has(place)) {
      items.push({ kind: "tab", tab });
      continue;
    }
    const group = groups.get(place);
    if (group) {
      group.push(tab);
      continue;
    }
    const fresh = [tab];
    groups.set(place, fresh);
    items.push({ kind: "group", id: groupItemId(place), place, tabs: fresh });
  }
  return items;
}

/** A drag's order of drawn items back to tab ids: a chip stands for its tabs. */
export function itemOrder(order: string[], items: StripItem[]): string[] {
  const byId = new Map(items.map((item) => [item.kind === "tab" ? item.tab.id : item.id, item]));
  return order.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [id];
    return item.kind === "tab" ? [item.tab.id] : item.tabs.map((tab) => tab.id);
  });
}
