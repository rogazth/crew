import type { Session, SessionStatus } from "./types";

/** What a session rests in before anything is said in it. */
const UNSPOKEN: ReadonlySet<SessionStatus> = new Set(["starting", "idle", "exited"]);

/** A name Crew made up for the provider, as `nextSessionName` does: claude, claude 2, … */
export function isDerivedName(name: string, base: string): boolean {
  if (name === base) return true;
  return name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1));
}

/**
 * Of the sessions this window opened blank, the ones still blank: here,
 * nothing said in them, none started from them, and the name still Crew's.
 * One that leaves never comes back, so a turn that ends idle keeps it. What was
 * said is in Crew's own transcript, which `said` reads: a turn stopped as it
 * began leaves the status at rest, and the words behind.
 */
export function stillBlank(
  blank: ReadonlySet<string>,
  sessions: Session[],
  said: (id: string) => boolean = () => false,
): ReadonlySet<string> {
  if (blank.size === 0) return blank;
  const parents = new Set(sessions.flatMap((session) => (session.parentId ? [session.parentId] : [])));
  // One the list has not caught up with yet stays: there is nothing to judge it by.
  const kept = new Set(blank);
  for (const session of sessions) {
    if (!blank.has(session.id)) continue;
    const spoke =
      parents.has(session.id) ||
      !UNSPOKEN.has(session.status) ||
      !isDerivedName(session.name, session.provider) ||
      said(session.id);
    if (spoke) kept.delete(session.id);
  }
  return kept.size === blank.size ? blank : kept;
}
