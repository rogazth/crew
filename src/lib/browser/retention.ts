/**
 * Which browser guests stay alive while hidden. The rest go cold and keep only
 * their saved stack. Like Chrome's: a hidden page stays loaded however long it
 * goes unseen, until the machine runs critically short of memory.
 */

/** How tight memory is, as main reads it from the OS. */
export type MemoryPressure = "normal" | "moderate" | "critical";

/** A page out of sight this recently is never dropped for memory: it was just being read. */
export const GRACE_MS = 5 * 60 * 1000;
/** How often the window asks for the pressure and sweeps the warm pages. */
export const SWEEP_MS = 30 * 1000;

/** Stands for "in use right now", so a page on screen or pinned costs no update per sweep. */
const IN_USE = Number.POSITIVE_INFINITY;

/**
 * Warm pages, each with when it was last in use (on screen, playing, driven),
 * or Infinity while it still is. A page absent from it is cold. The same map
 * back when nothing moves, so a React state setter bails out.
 */
export type Warm = ReadonlyMap<string, number>;

export function touch(warm: Warm, ids: Iterable<string>, now: number): Warm {
  let next: Map<string, number> | null = null;
  for (const id of ids) {
    if (warm.get(id) === now) continue;
    next ??= new Map(warm);
    next.set(id, now);
  }
  return next ?? warm;
}

/** The visible guest, every pinned one, and every warm one. */
export function liveGuests(input: { warm: Warm; visible: string | null; pinned: ReadonlySet<string> }): Set<string> {
  const live = new Set([...input.warm.keys(), ...input.pinned]);
  if (input.visible !== null) live.add(input.visible);
  return live;
}

/**
 * One sweep: what stays warm. Pinned pages (DevTools open, audio playing, a
 * form typed into, a download in flight, an incognito page, an agent driving
 * it) and the visible one are in use and never judged. The rest go only when
 * memory is critical, and then one a sweep, as Chrome's urgent discarding does:
 * the least recently used page past its grace, a busy workspace's only once no
 * other is left. Moderate pressure takes nothing; the OS compresses and swaps
 * well before it hurts.
 */
export function sweep(input: {
  warm: Warm;
  /** Every open page; a warm one no longer open is dropped. */
  ids: ReadonlySet<string>;
  visible: string | null;
  pinned: ReadonlySet<string>;
  /** Pages of a workspace with a session at work. */
  busy: ReadonlySet<string>;
  pressure: MemoryPressure;
  now: number;
}): Warm {
  const { warm, ids, visible, pinned, busy, pressure, now } = input;
  const kept = new Map<string, number>();
  for (const id of pinned) if (ids.has(id)) kept.set(id, IN_USE);
  if (visible !== null && ids.has(visible)) kept.set(visible, IN_USE);
  let oldest: string | null = null;
  let oldestBusy: string | null = null;
  for (const [id, last] of warm) {
    if (kept.has(id) || !ids.has(id)) continue;
    // A page that just stopped being in use starts its clock now.
    const at = last === IN_USE ? now : last;
    kept.set(id, at);
    if (pressure !== "critical" || now - at < GRACE_MS) continue;
    if (busy.has(id)) {
      if (oldestBusy === null || at < (kept.get(oldestBusy) as number)) oldestBusy = id;
    } else if (oldest === null || at < (kept.get(oldest) as number)) {
      oldest = id;
    }
  }
  const victim = oldest ?? oldestBusy;
  if (victim !== null) kept.delete(victim);
  const same = kept.size === warm.size && [...kept].every(([id, at]) => warm.get(id) === at);
  return same ? warm : kept;
}
