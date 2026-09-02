import type { CommandId } from "./commands";
import type { Session, StubKind, Tab } from "./types";

export const sessionTabId = (sessionId: string) => `session:${sessionId}`;
export const fileTabId = (path: string) => `file:${path}`;
export const stubTabId = (stub: StubKind) => `stub:${stub}`;

export function openTab(tabs: Tab[], tab: Tab): Tab[] {
  return tabs.some((t) => t.id === tab.id) ? tabs : [...tabs, tab];
}

export function closeTab(tabs: Tab[], id: string): Tab[] {
  return tabs.filter((t) => t.id !== id);
}

/** After closing the active tab, focus its right neighbour, else its left one. */
export function neighbourId(tabs: Tab[], closingId: string): string | null {
  const index = tabs.findIndex((t) => t.id === closingId);
  if (index === -1) return null;
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null;
}

/**
 * Which shortcut jumps to the tab at `index`, browser-style: the first eight get
 * their own digit, and the ninth is always the last tab, however many there are.
 */
export function tabHotkey(index: number, total: number): CommandId | null {
  if (index < 8) return `tab-${index + 1}` as CommandId;
  return index === total - 1 ? "last-tab" : null;
}

/** Restores what `state_set` wrote. Anything that no longer parses is dropped, not thrown. */
export function parseTabs(raw: string | null): { tabs: Tab[]; activeId: string | null } {
  const empty = { tabs: [], activeId: null };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(tabs)) return empty;
    const kept = tabs.filter(isTab);
    return {
      tabs: kept,
      activeId: kept.some((tab) => tab.id === activeId) ? (activeId as string) : (kept[0]?.id ?? null),
    };
  } catch {
    return empty;
  }
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Partial<Tab>;
  if (typeof tab.id !== "string") return false;
  if (tab.kind === "session") return typeof tab.sessionId === "string";
  if (tab.kind === "file") return typeof tab.path === "string" && typeof tab.relative === "string";
  if (tab.kind === "stub") return typeof tab.stub === "string" && typeof tab.title === "string";
  return false;
}

export function tabTitle(tab: Tab, sessions: Session[]): string {
  if (tab.kind === "stub") return tab.title;
  if (tab.kind === "file") return tab.relative.split("/").pop() ?? tab.relative;
  return sessions.find((s) => s.id === tab.sessionId)?.name ?? "Untitled";
}
