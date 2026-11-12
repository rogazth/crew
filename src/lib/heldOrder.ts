/**
 * The sidebar's rows, held where they stood while the pointer is over the list:
 * a session that moves (it ran, it finished, it was renamed) keeps its place
 * until the pointer leaves, so the row under the pointer is the one it was over.
 */

type Row = { id: string };
type Group<R extends Row> = { key: string; sessions: R[] };

/** Each group as it was on screen, with its rows by id. */
export type HeldOrder<G> = { group: G; ids: string[] }[];

export function holdOrder<R extends Row, G extends Group<R>>(groups: G[]): HeldOrder<G> {
  return groups.map((group) => ({ group, ids: group.sessions.map((s) => s.id) }));
}

/**
 * The live groups laid out as `held` had them. A row keeps its group and place,
 * with what it says now; a row gone is gone; a new row comes in at the top of
 * the group it falls in. A held group stays while it holds rows (or while the
 * live list still has it); a group new to the list comes in after the one it
 * follows there.
 */
export function applyHeld<R extends Row, G extends Group<R>>(live: G[], held: HeldOrder<G>): G[] {
  const byId = new Map<string, R>();
  for (const group of live) for (const session of group.sessions) byId.set(session.id, session);
  const known = new Set(held.flatMap((entry) => entry.ids));
  const liveByKey = new Map(live.map((group) => [group.key, group]));
  const fresh = (group: G | undefined) => (group?.sessions ?? []).filter((s) => !known.has(s.id));

  const out: G[] = [];
  for (const { group, ids } of held) {
    const now = liveByKey.get(group.key);
    const sessions = [...fresh(now), ...ids.flatMap((id) => byId.get(id) ?? [])];
    if (now || sessions.length > 0) out.push({ ...(now ?? group), sessions });
  }
  for (const [at, group] of live.entries()) {
    if (out.some((g) => g.key === group.key)) continue;
    const sessions = fresh(group);
    if (sessions.length === 0) continue;
    const before = live
      .slice(0, at)
      .reverse()
      .find((g) => out.some((o) => o.key === g.key));
    out.splice(before ? out.findIndex((g) => g.key === before.key) + 1 : 0, 0, { ...group, sessions });
  }
  return out;
}
