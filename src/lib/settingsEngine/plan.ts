// What a reconciliation does, with nothing around it: given what each daemon
// holds, what each one is missing. See `settings` in crew-core for the rows.
import type { SettingRow } from "../protocol";

const GLOBAL = "global";

/** The daemon's own order: revision, then origin, so every copy picks the same row. */
export function isNewer(a: SettingRow, b: SettingRow): boolean {
  if (a.revision !== b.revision) return a.revision > b.revision;
  return a.origin > b.origin;
}

/** The newest row of each global key across the copies. */
export function winners(copies: SettingRow[][]): Map<string, SettingRow> {
  const best = new Map<string, SettingRow>();
  for (const copy of copies) {
    for (const row of copy) {
      if (row.scope !== GLOBAL) continue;
      const held = best.get(row.key);
      if (!held || isNewer(row, held)) best.set(row.key, row);
    }
  }
  return best;
}

/** The winners this copy does not hold yet. */
export function missingFrom(copy: SettingRow[], best: Map<string, SettingRow>): SettingRow[] {
  const here = new Map(copy.map((row) => [row.key, row]));
  return [...best.values()].filter((row) => {
    const held = here.get(row.key);
    return !held || isNewer(row, held);
  });
}

/**
 * The known keys that only ever existed from before the engine: revision 0 on
 * some copy, and no copy holding a real choice. This machine's value stands as
 * the first real one, its absence included, or a remote's forgotten value would
 * beat what the user sees in Settings. A key on no copy has nothing to settle: a
 * new install must not overwrite a machine it has yet to hear from.
 */
export function toSeed(keys: string[], local: SettingRow[], others: SettingRow[][]): string[] {
  const copies = [local, ...others];
  return keys.filter((key) => {
    const rows = copies.flatMap((copy) => copy.filter((row) => row.key === key));
    return rows.length > 0 && rows.every((row) => row.revision === 0);
  });
}

export function newestRevision(best: Map<string, SettingRow>): number {
  let newest = 0;
  for (const row of best.values()) newest = Math.max(newest, row.revision);
  return newest;
}
