import type { Session, SessionKind } from "./types";
import { filterSessions } from "./workspaces";

export type Ordering = "manual" | "updated" | "name";
export type Detail = "names" | "diff" | "updated" | "status";
/** Which worktrees the panel lists: every one, the one on screen, or those with something running. */
export type Scope = "all" | "current" | "busy";
/** How long ago a session last moved, at most, to still be listed. */
export type Recency = "any" | "day" | "3days" | "week";

const HOUR = 60 * 60 * 1000;
const RECENCY_MS: Record<Recency, number | null> = { any: null, day: 24 * HOUR, "3days": 72 * HOUR, week: 168 * HOUR };

/** Rows a worktree's section lists before the rest fold under "N more"; 0 lists every one. */
export const LIMITS = [5, 10, 20, 0] as const;
export type Limit = (typeof LIMITS)[number];

export type SidebarPrefs = {
  scope: Scope;
  ordering: Ordering;
  show: Detail[];
  hiddenKinds: SessionKind[];
  hiddenProviders: string[];
  recency: Recency;
  limit: Limit;
};

export const DEFAULT_PREFS: SidebarPrefs = {
  scope: "all",
  ordering: "updated",
  show: ["names", "diff", "updated", "status"],
  hiddenKinds: [],
  hiddenProviders: [],
  recency: "any",
  limit: 10,
};

/** The panel's two fixed sections: agents as a grid of faces, sessions as rows. */
export type Arranged = { agents: Session[]; terminals: Session[] };

export function shows(prefs: SidebarPrefs, detail: Detail): boolean {
  return prefs.show.includes(detail);
}

export function isDefault(prefs: SidebarPrefs): boolean {
  return (
    prefs.scope === DEFAULT_PREFS.scope &&
    prefs.ordering === DEFAULT_PREFS.ordering &&
    prefs.show.length === DEFAULT_PREFS.show.length &&
    prefs.hiddenKinds.length === 0 &&
    prefs.hiddenProviders.length === 0 &&
    prefs.recency === DEFAULT_PREFS.recency &&
    prefs.limit === DEFAULT_PREFS.limit
  );
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Manual order is the only one the store persists, so only it can be dragged. */
export function canReorder(prefs: SidebarPrefs, filtering: boolean): boolean {
  return !filtering && prefs.ordering === "manual";
}

const KNOWN_DETAILS = new Set<unknown>(DEFAULT_PREFS.show);

/** Unknown keys from older builds — grouping, the avatar detail — fall away. */
export function parsePrefs(raw: string | null): SidebarPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      scope: pick(parsed.scope, ["all", "current", "busy"], "all"),
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
      recency: pick(parsed.recency, ["any", "day", "3days", "week"], DEFAULT_PREFS.recency),
      limit: LIMITS.find((limit) => limit === parsed.limit) ?? DEFAULT_PREFS.limit,
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

/** Filter, search and order in one pass, then split by kind. A search ranks by match, not by ordering. */
export function arrangeSessions(sessions: Session[], prefs: SidebarPrefs, query: string): Arranged {
  const hiddenKinds = new Set(prefs.hiddenKinds);
  const hiddenProviders = new Set(prefs.hiddenProviders);
  const kept = sessions.filter(
    (session) => !hiddenKinds.has(session.kind) && !hiddenProviders.has(session.provider),
  );
  const ordered = query.trim() ? filterSessions(kept, query) : sort(kept, prefs.ordering);
  return {
    agents: ordered.filter((session) => session.kind === "agent"),
    terminals: ordered.filter((session) => session.kind === "terminal"),
  };
}

/** A section's rows as listed, and how many were left out. */
export type Trimmed = { shown: Session[]; hidden: number };

/** Never left out: the one on screen, and any still working, asking or unread. */
function held(session: Session, activeId: string | null): boolean {
  return session.id === activeId || session.status !== "idle";
}

/**
 * Drops what has not moved within the recency, then keeps the first `limit`
 * in the order given. Held rows stay wherever they fall and use up the limit
 * like any other, so the rest only fill what room is left.
 */
export function trimSection(
  sessions: Session[],
  prefs: SidebarPrefs,
  activeId: string | null,
  now: number,
): Trimmed {
  const span = RECENCY_MS[prefs.recency];
  const recent =
    span === null
      ? sessions
      : sessions.filter((session) => held(session, activeId) || session.updatedAt >= now - span);
  let room = prefs.limit === 0 ? Infinity : prefs.limit - recent.filter((s) => held(s, activeId)).length;
  const shown = recent.filter((session) => held(session, activeId) || room-- > 0);
  return { shown, hidden: sessions.length - shown.length };
}
