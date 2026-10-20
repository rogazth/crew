import { useSyncExternalStore } from "react";
import * as api from "../lib/api";
import { accentFromDirection, DEFAULT_ACCENT, parseAccent, type AccentId } from "../lib/accent";

const KEY = "app:accent";
/** This window's copy of the pick, so the first paint is in the right palette before the store answers. */
const MIRROR = "crew-accent";
/** The redesign's dev bar kept its pick here; read once, then gone. */
const LEGACY = {
  direction: "crew-proto-direction",
  theme: "crew-proto-theme",
  update: "crew-proto-update",
  review: "crew-proto-review-state",
} as const;

let current: AccentId = DEFAULT_ACCENT;
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the pick still holds for this window.
  }
}

function set(next: AccentId) {
  if (next === current && document.documentElement.dataset.accent === next) return;
  current = next;
  document.documentElement.dataset.accent = next;
  write(MIRROR, next);
  for (const listener of listeners) listener();
}

/**
 * Applies the palette to <html> before the first render, then reconciles with
 * the stored pick. A pick the redesign's dev bar left in localStorage moves
 * into the store once. Its theme (the app's own colour mode holds that), its
 * simulated update and its review state have no use any more and are dropped.
 */
export function bootAccent() {
  set(parseAccent(read(MIRROR)));
  void reconcile();
}

async function reconcile() {
  try {
    const stored = await api.stateGet(KEY);
    const legacy = accentFromDirection(read(LEGACY.direction));
    if (stored === null && legacy) {
      await api.stateSet(KEY, legacy);
      set(legacy);
    } else set(parseAccent(stored));
    for (const key of Object.values(LEGACY)) write(key, null);
  } catch {
    // The store is not up yet: the mirror stands, and the old keys wait for the next launch.
  }
}

export function setAccent(next: AccentId) {
  set(next);
  void api.stateSet(KEY, next).catch(() => {});
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useAccent() {
  return { accent: useSyncExternalStore(subscribe, () => current), update: setAccent };
}
