import type { Session, SessionStatus } from "./types";

/** A session in one of these is waiting on the user: to answer it, or to read what it did. */
const ATTENTION = new Set<SessionStatus>(["needs-input", "done", "error"]);

export function attentionOf(sessions: readonly Pick<Session, "id" | "status" | "notifications">[]): Set<string> {
  const waiting = new Set<string>();
  for (const session of sessions) if (session.notifications && ATTENTION.has(session.status)) waiting.add(session.id);
  return waiting;
}

/** What the Dock counts: sessions waiting since the user last had Crew in front. */
export type BadgeState = { seen: ReadonlySet<string>; count: number };

export const NO_BADGE: BadgeState = { seen: new Set(), count: 0 };

/**
 * Crew in front sees everything waiting, and the count is zero. In the
 * background it counts what started waiting since; a session that stops
 * waiting is forgotten, so waiting again counts again.
 */
export function nextBadge(prev: BadgeState, attention: ReadonlySet<string>, focused: boolean): BadgeState {
  if (focused) return { seen: new Set(attention), count: 0 };
  const seen = new Set([...prev.seen].filter((id) => attention.has(id)));
  let count = 0;
  for (const id of attention) if (!seen.has(id)) count += 1;
  return { seen, count };
}
