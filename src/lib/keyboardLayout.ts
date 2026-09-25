import type { KeyboardLayout } from "./keymap";

type LayoutMap = { forEach(cb: (value: string, code: string) => void): void };
type KeyboardApi = { getLayoutMap(): Promise<LayoutMap> };

let layout: KeyboardLayout | undefined;
const listeners = new Set<() => void>();
let watching = false;

/** What each physical key types on the layout in use, once Chromium has said; undefined until then or without the API. */
export function keyboardLayout(): KeyboardLayout | undefined {
  return layout;
}

async function refresh(): Promise<void> {
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardApi }).keyboard;
  if (!keyboard) return;
  let map: LayoutMap;
  try {
    map = await keyboard.getLayoutMap();
  } catch {
    return;
  }
  const next: Record<string, string> = {};
  map.forEach((value, code) => {
    next[code] = value;
  });
  if (layout && JSON.stringify(layout) === JSON.stringify(next)) return;
  layout = next;
  for (const listener of listeners) listener();
}

/**
 * Starts reading the layout. Chromium fires no event when it changes, so it is
 * read again whenever the window comes back to the front: switching input
 * source from the menu bar takes focus away first.
 */
export function watchKeyboardLayout(): void {
  if (watching) return;
  watching = true;
  void refresh();
  window.addEventListener("focus", () => void refresh());
}

/** Tells `cb` when the layout read changes. */
export function onKeyboardLayoutChange(cb: () => void): () => void {
  watchKeyboardLayout();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
