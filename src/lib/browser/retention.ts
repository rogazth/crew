/**
 * Which browser guests stay alive while hidden. The rest go cold and keep only
 * their saved stack. Like Chrome's: a page goes cold after a while out of
 * sight, sooner when the machine runs short of memory.
 */

/** How tight memory is, as main reads it from the OS. */
export type MemoryPressure = "normal" | "moderate" | "critical";

/** A hidden page left alone this long goes cold, whatever the memory. */
export const IDLE_MS = 60 * 60 * 1000;
/** Under moderate pressure a page out of sight this long may go, one per sweep. */
export const GRACE_MS = 5 * 60 * 1000;
/** How often the window asks for the pressure and sweeps the warm pages. */
export const SWEEP_MS = 30 * 1000;

/**
 * Warm pages, each with when it was last in use: on screen, playing, driven.
 * A page absent from it is cold. The same map back when nothing moves, so a
 * React state setter bails out.
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
 * download in flight, an incognito page, an agent driving it) and the visible
 * one are in use, so they're touched rather than judged. Pages of a workspace
 * with work in flight are spared until memory is critical. Under moderate
 * pressure the least recently used page past its grace goes as well, one a
 * sweep, so memory gets a chance to recover before the next one does.
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
  const { ids, pinned, busy, pressure, now } = input;
  const used = [...pinned, ...(input.visible === null ? [] : [input.visible])].filter((id) => ids.has(id));
  const warm = touch(input.warm, used, now);
  const inUse = new Set(used);
  const kept = new Map<string, number>();
  let oldest: string | null = null;
  for (const [id, at] of warm) {
    if (!ids.has(id)) continue;
    if (inUse.has(id)) {
      kept.set(id, at);
      continue;
    }
    if (pressure === "critical") continue;
    if (busy.has(id)) {
      kept.set(id, now);
      continue;
    }
    if (now - at >= IDLE_MS) continue;
    kept.set(id, at);
    if (now - at >= GRACE_MS && (oldest === null || at < (kept.get(oldest) as number))) oldest = id;
  }
  if (pressure === "moderate" && oldest !== null) kept.delete(oldest);
  const same = kept.size === warm.size && [...kept].every(([id, at]) => warm.get(id) === at);
  return same ? warm : kept;
}
