import type { Session } from "./types";

/**
 * The daemon's list, read again over the one on screen. The daemon decides who
 * is there and in what order; a session this window already holds keeps its
 * status, which the window reports while it runs. One made while the read was
 * in flight stays, since the daemon answered before it existed.
 */
export function mergeReloaded(held: Session[], loaded: Session[], madeSince: ReadonlySet<string>): Session[] {
  const mine = new Map(held.map((session) => [session.id, session]));
  const listed = new Set(loaded.map((session) => session.id));
  const merged = loaded.map((row) => {
    const session = mine.get(row.id);
    return session ? { ...row, status: session.status } : row;
  });
  return [...merged, ...held.filter((session) => !listed.has(session.id) && madeSince.has(session.id))];
}

/** Who a reload let go: held, not listed, and not made while it was in flight. */
export function droppedOnReload(held: Session[], loaded: Session[], madeSince: ReadonlySet<string>): string[] {
  const listed = new Set(loaded.map((session) => session.id));
  return held.filter((session) => !listed.has(session.id) && !madeSince.has(session.id)).map((session) => session.id);
}

/**
 * A row the daemon says changed, over the one on screen: the bot's own
 * rewrite of its description, a terminal that moved to a new conversation.
 * Its status stays the window's to report, but for the unread the daemon
 * handed to the conversation it left.
 */
export function applyUpdated(held: Session, row: Session): Session {
  return {
    ...held,
    name: row.name,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    autonomy: row.autonomy,
    description: row.description,
    providerSessionId: row.providerSessionId,
    status: held.status === "done" ? row.status : held.status,
    // Where it got and what the user read of it: a child's chip, a handoff's unread dot.
    ...(row.cursor !== undefined ? { cursor: row.cursor } : {}),
    ...(row.userSeen !== undefined ? { userSeen: row.userSeen } : {}),
    ...(row.lastEvent ? { lastEvent: row.lastEvent } : {}),
    ...(row.parentName !== undefined ? { parentName: row.parentName } : {}),
    ...(row.handedOffByName !== undefined ? { handedOffByName: row.handedOffByName } : {}),
  };
}
