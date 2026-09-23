import { providerOf } from "./providers";
import { STATUS_ORDER, statusLabel } from "./status";
import type { Session, SessionKind } from "./types";
import { filterSessions } from "./workspaces";

export type Grouping = "none" | "kind" | "provider" | "status";
export type Ordering = "manual" | "updated" | "name";
export type Detail = "provider" | "updated" | "status" | "avatar";

export type SidebarPrefs = {
  grouping: Grouping;
  ordering: Ordering;
  show: Detail[];
  hiddenKinds: SessionKind[];
  hiddenProviders: string[];
};

/** The defaults reproduce the two fixed sections the sidebar shipped with. */
export const DEFAULT_PREFS: SidebarPrefs = {
  grouping: "kind",
  ordering: "updated",
  show: ["provider", "updated", "status", "avatar"],
  hiddenKinds: [],
  hiddenProviders: [],
};

export type SessionGroup = {
  id: string;
  label: string;
  /** Set only when every row in the group shares one kind, which is what an add button needs. */
  kind: SessionKind | null;
  sessions: Session[];
};

export function shows(prefs: SidebarPrefs, detail: Detail): boolean {
  return prefs.show.includes(detail);
}

export function isDefault(prefs: SidebarPrefs): boolean {
  return (
    prefs.grouping === DEFAULT_PREFS.grouping &&
    prefs.ordering === DEFAULT_PREFS.ordering &&
    prefs.show.length === DEFAULT_PREFS.show.length &&
    prefs.hiddenKinds.length === 0 &&
    prefs.hiddenProviders.length === 0
  );
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * Manual order is the only one the store can persist, and `session_reorder` rewrites
 * one kind at a time — so dragging is offered only for the layout it can round-trip.
 */
export function canReorder(prefs: SidebarPrefs, filtering: boolean): boolean {
  return !filtering && prefs.ordering === "manual" && prefs.grouping === "kind";
}

const KNOWN_DETAILS = new Set<unknown>(DEFAULT_PREFS.show);

export function parsePrefs(raw: string | null): SidebarPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      grouping: pick(parsed.grouping, ["none", "kind", "provider", "status"], "kind"),
      ordering: pick(parsed.ordering, ["manual", "updated", "name"], "updated"),
      show: Array.isArray(parsed.show)
        ? (parsed.show.filter((d) => KNOWN_DETAILS.has(d)) as Detail[])
        : DEFAULT_PREFS.show,
      hiddenKinds: Array.isArray(parsed.hiddenKinds)
        ? (parsed.hiddenKinds.filter((k) => k === "agent" || k === "terminal") as SessionKind[])
        : [],
      hiddenProviders: Array.isArray(parsed.hiddenProviders)
        ? parsed.hiddenProviders.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function pick<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function sort(sessions: Session[], ordering: Ordering): Session[] {
  if (ordering === "manual") return sessions;
  const next = [...sessions];
  if (ordering === "updated") next.sort((a, b) => b.updatedAt - a.updatedAt);
  else next.sort((a, b) => a.name.localeCompare(b.name));
  return next;
}

function bucket(sessions: Session[], key: (session: Session) => string): Map<string, Session[]> {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const id = key(session);
    const list = groups.get(id);
    if (list) list.push(session);
    else groups.set(id, [session]);
  }
  return groups;
}

const KIND_LABEL: Record<SessionKind, string> = { agent: "Agents", terminal: "Sessions" };

/** Filter, search, order and group in one pass. Empty groups never render. */
export function groupSessions(
  sessions: Session[],
  prefs: SidebarPrefs,
  query: string,
): SessionGroup[] {
  const hiddenKinds = new Set(prefs.hiddenKinds);
  const hiddenProviders = new Set(prefs.hiddenProviders);
  const kept = sessions.filter(
    (session) => !hiddenKinds.has(session.kind) && !hiddenProviders.has(session.provider),
  );
  const ordered = sort(filterSessions(kept, query), prefs.ordering);

  if (prefs.grouping === "none") {
    return ordered.length === 0 ? [] : [{ id: "all", label: "All", kind: null, sessions: ordered }];
  }

  if (prefs.grouping === "kind") {
    const groups = bucket(ordered, (session) => session.kind);
    const out: SessionGroup[] = [];
    for (const kind of ["agent", "terminal"] as SessionKind[]) {
      const list = groups.get(kind);
      if (list) out.push({ id: kind, label: KIND_LABEL[kind], kind, sessions: list });
    }
    return out;
  }

  if (prefs.grouping === "provider") {
    const groups = bucket(ordered, (session) => session.provider);
    return [...groups].map(([id, list]) => ({
      id,
      label: providerOf(id)?.label ?? id,
      kind: null,
      sessions: list,
    }));
  }

  const groups = bucket(ordered, (session) => session.status);
  const out: SessionGroup[] = [];
  for (const status of STATUS_ORDER) {
    const list = groups.get(status);
    if (list) out.push({ id: status, label: statusLabel(status), kind: null, sessions: list });
  }
  return out;
}
