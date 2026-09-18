import type { Session, SessionKind, SessionStatus } from "@crew/fixtures";
import { STATUS_ORDER, providerOf, statusLabel } from "@crew/fixtures";

export type Grouping = "none" | "kind" | "provider" | "status";
export type Ordering = "manual" | "updated" | "name";

export type SidebarPrefs = {
  grouping: Grouping;
  ordering: Ordering;
  showProvider: boolean;
  showUpdated: boolean;
  showStatus: boolean;
  showAvatar: boolean;
  hiddenKinds: SessionKind[];
  hiddenProviders: string[];
  collapsedGroups: string[];
};

export const DEFAULT_PREFS: SidebarPrefs = {
  grouping: "kind",
  ordering: "updated",
  showProvider: true,
  showUpdated: true,
  showStatus: true,
  showAvatar: true,
  hiddenKinds: [],
  hiddenProviders: [],
  collapsedGroups: [],
};

export const GROUPINGS: Array<{ id: Grouping; label: string }> = [
  { id: "none", label: "None" },
  { id: "kind", label: "Kind" },
  { id: "provider", label: "Provider" },
  { id: "status", label: "Status" },
];

export const ORDERINGS: Array<{ id: Ordering; label: string }> = [
  { id: "manual", label: "Manual" },
  { id: "updated", label: "Last updated" },
  { id: "name", label: "Name" },
];

export type SessionGroup = { id: string; label: string; sessions: Session[] };

const KIND_LABEL: Record<SessionKind, string> = { agent: "Agents", terminal: "Terminals" };

function groupKeyOf(session: Session, grouping: Grouping): { id: string; label: string } {
  switch (grouping) {
    case "kind":
      return { id: session.kind, label: KIND_LABEL[session.kind] };
    case "provider":
      return {
        id: session.provider,
        label: providerOf(session.provider)?.label ?? session.provider,
      };
    case "status":
      return { id: session.status, label: statusLabel(session.status) };
    case "none":
      return { id: "all", label: "Sessions" };
  }
}

function compare(a: Session, b: Session, ordering: Ordering, manual: string[]): number {
  switch (ordering) {
    case "name":
      return a.name.localeCompare(b.name);
    case "updated":
      return b.updatedAt - a.updatedAt;
    case "manual": {
      const ai = manual.indexOf(a.id);
      const bi = manual.indexOf(b.id);
      if (ai === -1 && bi === -1) return b.updatedAt - a.updatedAt;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
  }
}

export function filterSessions(
  sessions: Session[],
  workspaceId: string,
  prefs: SidebarPrefs,
  query: string,
): Session[] {
  const needle = query.trim().toLowerCase();
  return sessions.filter((session) => {
    if (session.workspaceId !== workspaceId) return false;
    if (prefs.hiddenKinds.includes(session.kind)) return false;
    if (session.kind === "agent" && prefs.hiddenProviders.includes(session.provider)) return false;
    if (!needle) return true;
    return (
      session.name.toLowerCase().includes(needle) ||
      session.description.toLowerCase().includes(needle) ||
      session.provider.toLowerCase().includes(needle)
    );
  });
}

export function groupSessions(
  sessions: Session[],
  prefs: SidebarPrefs,
  manualOrder: string[],
): SessionGroup[] {
  const sorted = sessions.slice().sort((a, b) => compare(a, b, prefs.ordering, manualOrder));
  if (prefs.grouping === "none") {
    return [{ id: "all", label: "Sessions", sessions: sorted }];
  }
  const map = new Map<string, SessionGroup>();
  for (const session of sorted) {
    const key = groupKeyOf(session, prefs.grouping);
    const held = map.get(key.id);
    if (held) held.sessions.push(session);
    else map.set(key.id, { id: key.id, label: key.label, sessions: [session] });
  }
  const groups = [...map.values()];
  if (prefs.grouping === "status") {
    groups.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.id as SessionStatus) - STATUS_ORDER.indexOf(b.id as SessionStatus),
    );
  }
  if (prefs.grouping === "kind") {
    groups.sort((a, b) => (a.id === "agent" ? -1 : b.id === "agent" ? 1 : 0));
  }
  return groups;
}

/** Drag-reorder is only honest when the list is in manual order and unfiltered. */
export function canReorder(prefs: SidebarPrefs, query: string): boolean {
  return prefs.ordering === "manual" && prefs.grouping === "kind" && query.trim().length === 0;
}
