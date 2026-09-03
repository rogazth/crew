export type Selection = { ids: string[]; anchor: string | null };

export const NO_SELECTION: Selection = { ids: [], anchor: null };

export type ClickModifiers = { toggle: boolean; range: boolean };

/** Finder-style click: plain replaces, ⌘/Ctrl toggles, Shift extends from the anchor in list order. */
export function selectClick(
  selection: Selection,
  order: string[],
  id: string,
  { toggle, range }: ClickModifiers,
): Selection {
  if (range && selection.anchor !== null) {
    const from = order.indexOf(selection.anchor);
    const to = order.indexOf(id);
    if (from === -1 || to === -1) return { ids: [id], anchor: id };
    const [lo, hi] = from < to ? [from, to] : [to, from];
    return { ids: order.slice(lo, hi + 1), anchor: selection.anchor };
  }
  if (toggle) {
    const ids = selection.ids.includes(id)
      ? selection.ids.filter((other) => other !== id)
      : [...selection.ids, id];
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}

/** Drops ids that left the list; the anchor survives only while it is still visible. */
export function pruneSelection(selection: Selection, order: string[]): Selection {
  const visible = new Set(order);
  const ids = selection.ids.filter((id) => visible.has(id));
  if (ids.length === selection.ids.length) return selection;
  return { ids, anchor: selection.anchor && visible.has(selection.anchor) ? selection.anchor : null };
}
