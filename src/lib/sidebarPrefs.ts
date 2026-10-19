import type { Session, SessionKind } from "./types";
import { isOwnedChild } from "./letters";
import { filterSessions } from "./workspaces";

export type Ordering = "manual" | "updated" | "name";
export type Detail = "names" | "diff" | "updated" | "status";
/** How the sessions are laid out; each says on a session's second line only what its group does not. */
export type Grouping = "none" | "worktree" | "status";

/** Sessions under their worktree until the view menu says otherwise. */
export const DEFAULT_GROUPING: Grouping = "worktree";

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
  groupBy: Grouping;
  /** Under "none" and "status" a session's second line names its worktree; this turns that off. */
  showWorktree: boolean;
  /** Worktrees left out of the list, by path. */
  hiddenTrees: string[];
};

export const DEFAULT_PREFS: SidebarPrefs = {
  scope: "all",
  ordering: "updated",
  show: ["names", "diff", "updated", "status"],
  hiddenKinds: [],
  hiddenProviders: [],
  recency: "any",
  limit: 10,
  groupBy: DEFAULT_GROUPING,
  showWorktree: true,
  hiddenTrees: [],
};

/** The panel's two fixed sections: bots as a grid of faces, sessions as rows. */
export type Arranged = { bots: Session[]; terminals: Session[] };

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
    prefs.limit === DEFAULT_PREFS.limit &&
    prefs.groupBy === DEFAULT_PREFS.groupBy &&
    prefs.showWorktree === DEFAULT_PREFS.showWorktree &&
    prefs.hiddenTrees.length === 0
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
        ? (parsed.hiddenKinds.filter((k) => k === "bot" || k === "terminal") as SessionKind[])
        : [],
      hiddenProviders: Array.isArray(parsed.hiddenProviders)
        ? parsed.hiddenProviders.filter((p): p is string => typeof p === "string")
        : [],
      recency: pick(parsed.recency, ["any", "day", "3days", "week"], DEFAULT_PREFS.recency),
      limit: LIMITS.find((limit) => limit === parsed.limit) ?? DEFAULT_PREFS.limit,
      groupBy: pick(parsed.groupBy, ["none", "worktree", "status"], DEFAULT_GROUPING),
      showWorktree: typeof parsed.showWorktree === "boolean" ? parsed.showWorktree : true,
      hiddenTrees: Array.isArray(parsed.hiddenTrees)
        ? parsed.hiddenTrees.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Where the redesign's dev build kept these three in this browser, before they lived in the store. */
export const LEGACY_KEYS = {
  groupBy: "crew-proto-grouping",
  hiddenTrees: "crew-proto-hidden-trees",
  showWorktree: "crew-proto-show-worktree",
} as const;

/** The picks those keys still hold, each stored as JSON; nothing for one that is missing or unreadable. */
export function legacyPrefs(read: (key: string) => string | null): Partial<SidebarPrefs> {
  const out: Partial<SidebarPrefs> = {};
  const json = (key: string): unknown => {
    try {
      const raw = read(key);
      return raw === null ? undefined : (JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  };
  const groupBy = json(LEGACY_KEYS.groupBy);
  if (groupBy === "none" || groupBy === "worktree" || groupBy === "status") out.groupBy = groupBy;
  const hidden = json(LEGACY_KEYS.hiddenTrees);
  if (Array.isArray(hidden)) out.hiddenTrees = hidden.filter((p): p is string => typeof p === "string");
  const show = json(LEGACY_KEYS.showWorktree);
  if (typeof show === "boolean") out.showWorktree = show;
  return out;
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

function kept(sessions: Session[], prefs: SidebarPrefs): Session[] {
  const hiddenKinds = new Set(prefs.hiddenKinds);
  const hiddenProviders = new Set(prefs.hiddenProviders);
  return sessions.filter((session) => !hiddenKinds.has(session.kind) && !hiddenProviders.has(session.provider));
}

/**
 * Filter, search and order in one pass, then split by kind. A search ranks by match, not by ordering.
 * A child its starter owns lives in that one's chat, not here: it is left out unless its starter is
 * gone, when it stands among the sessions as one the user started would. A handoff is the user's
 * and is listed like any of theirs. A search lists every match, children too.
 */
export function arrangeSessions(sessions: Session[], prefs: SidebarPrefs, query: string): Arranged {
  const listed = kept(sessions, prefs);
  const searching = query.trim().length > 0;
  const ordered = searching ? filterSessions(listed, query) : sort(listed, prefs.ordering);
  const present = new Set(sessions.map((session) => session.id));
  const housed = (session: Session) => !searching && isOwnedChild(session) && present.has(session.parentId!);
  return {
    bots: ordered.filter((session) => session.kind === "bot"),
    terminals: ordered.filter(
      (session) => session.kind === "terminal" || (session.kind === "child" && !housed(session)),
    ),
  };
}

/** A section's rows as listed, and how many were left out. */
export type Trimmed = { shown: Session[]; hidden: number };

/** Never left out: the one on screen, and any still working, asking or unread. */
function held(session: Session, activeId: string | null): boolean {
  return session.id === activeId || (session.status !== "idle" && session.status !== "exited");
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
