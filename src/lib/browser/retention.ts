/** Which browser guests stay alive while hidden. The rest go cold and keep only their saved stack. */

export const DEFAULT_KEEP = 6;

/** Most recently shown first. The same array back when nothing moves, so a React state setter bails out. */
export function touch(order: readonly string[], id: string): readonly string[] {
  if (order[0] === id) return order;
  return [id, ...order.filter((other) => other !== id)];
}

export function forget(order: readonly string[], id: string): readonly string[] {
  return order.includes(id) ? order.filter((other) => other !== id) : order;
}

/**
 * The visible guest, every pinned one (DevTools open, audio playing or a
 * download in flight), and the `keep` most recent of the rest. Pinned guests
 * don't use up the budget: discarding one would lose what it's doing.
 */
export function liveGuests(input: {
  order: readonly string[];
  visible: string | null;
  keep: number;
  pinned: ReadonlySet<string>;
}): Set<string> {
  const live = new Set(input.pinned);
  if (input.visible !== null) live.add(input.visible);
  let kept = 0;
  for (const id of input.order) {
    if (kept >= input.keep) break;
    if (live.has(id)) continue;
    live.add(id);
    kept += 1;
  }
  return live;
}
