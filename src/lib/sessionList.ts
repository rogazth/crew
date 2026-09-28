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
