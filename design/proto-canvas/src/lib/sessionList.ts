import {
  STATUS_ORDER,
  providerOf,
  statusLabel,
  type Session,
  type SessionStatus,
} from "@crew/fixtures";
import type { SidebarPrefs } from "./store";

export type SessionGroup = { id: string; label: string; sessions: Session[] };

const byName = (a: Session, b: Session) => a.name.localeCompare(b.name);

export function visibleSessions(
  sessions: Session[],
  prefs: SidebarPrefs,
  query: string,
): Session[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (prefs.hideKinds.includes(session.kind)) return false;
    if (prefs.hideProviders.includes(session.provider)) return false;
    if (needle && !session.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export function orderSessions(
  sessions: Session[],
  prefs: SidebarPrefs,
  manualOrder: string[],
): Session[] {
  const out = sessions.slice();
  switch (prefs.ordering) {
    case "name":
      return out.sort(byName);
    case "manual":
      return out.sort((a, b) => manualOrder.indexOf(a.id) - manualOrder.indexOf(b.id));
    case "updated":
    default:
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export function groupSessions(
  sessions: Session[],
  prefs: SidebarPrefs,
  statusOf: (id: string) => SessionStatus,
): SessionGroup[] {
  switch (prefs.grouping) {
    case "none":
      return [{ id: "all", label: "", sessions }];
    case "kind": {
      const agents = sessions.filter((s) => s.kind === "agent");
      const terminals = sessions.filter((s) => s.kind === "terminal");
      return [
        { id: "agent", label: "Agents", sessions: agents },
        { id: "terminal", label: "Terminals", sessions: terminals },
      ].filter((g) => g.sessions.length > 0);
    }
    case "provider": {
      const map = new Map<string, Session[]>();
      for (const session of sessions) {
        const key = session.kind === "terminal" ? "terminal" : session.provider;
        const held = map.get(key);
        if (held) held.push(session);
        else map.set(key, [session]);
      }
      return [...map].map(([key, list]) => ({
        id: key,
        label: key === "terminal" ? "Terminals" : (providerOf(key)?.label ?? key),
        sessions: list,
      }));
    }
    case "status": {
      const map = new Map<SessionStatus, Session[]>();
      for (const session of sessions) {
        const status = statusOf(session.id);
        const held = map.get(status);
        if (held) held.push(session);
        else map.set(status, [session]);
      }
      return STATUS_ORDER.filter((status) => map.has(status)).map((status) => ({
        id: status,
        label: statusLabel(status),
        sessions: map.get(status) ?? [],
      }));
    }
  }
}

/** Manual drag only makes sense when the list is showing you its real order. */
export const canReorder = (prefs: SidebarPrefs, query: string): boolean =>
  prefs.ordering === "manual" && prefs.grouping === "kind" && query.trim().length === 0;
