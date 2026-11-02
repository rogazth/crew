import type { TabRegistry } from "./tabs";
import type { TraceFields } from "./trace";
import type { Tab } from "./types";

export type TabEvent = { message: "tab.open" | "tab.close" | "tab.switch"; fields: TraceFields };

/**
 * What the trace may say of a tab: its kind, and the id of the session or the kind of terminal
 * it shows. Never a URL, a file's path or a title: a page's and a file's tab id hold those.
 */
function describe(workspace: string, tab: Tab, count: number): TraceFields {
  return {
    workspace,
    kind: tab.kind,
    ...(tab.kind === "session" ? { session: tab.sessionId } : {}),
    ...(tab.kind === "stub" ? { stub: tab.stub } : {}),
    tabs: count,
  };
}

/**
 * The tabs opened, closed and switched to between two registries. A workspace that was not in the
 * first one is being restored, not used, so it says nothing.
 */
export function tabEvents(prev: TabRegistry, next: TabRegistry): TabEvent[] {
  const events: TabEvent[] = [];
  for (const [workspace, after] of Object.entries(next)) {
    const before = prev[workspace];
    if (!before || before === after) continue;
    const had = new Set(before.tabs.map((tab) => tab.id));
    const has = new Set(after.tabs.map((tab) => tab.id));
    const opened = after.tabs.filter((tab) => !had.has(tab.id));
    for (const tab of opened) events.push({ message: "tab.open", fields: describe(workspace, tab, after.tabs.length) });
    for (const tab of before.tabs.filter((tab) => !has.has(tab.id))) {
      events.push({ message: "tab.close", fields: describe(workspace, tab, after.tabs.length) });
    }
    const active = after.tabs.find((tab) => tab.id === after.activeId);
    // A tab that opened in front is said by its opening.
    if (active && after.activeId !== before.activeId && !opened.some((tab) => tab.id === active.id)) {
      events.push({ message: "tab.switch", fields: describe(workspace, active, after.tabs.length) });
    }
  }
  return events;
}
