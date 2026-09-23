import type { LoadError } from "./loadError";

/**
 * What a live page is doing right now. It stays out of `TabState` so that a
 * navigation re-renders only that page's toolbar and tab pill, never the shell.
 */
export type PageState = {
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: LoadError | null;
  crashed: boolean;
  devtools: boolean;
  webContentsId: number | null;
};

export const BLANK_PAGE: PageState = Object.freeze({
  url: "about:blank",
  title: "",
  favicon: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
  crashed: false,
  devtools: false,
  webContentsId: null,
});

export type PageStore = {
  /** BLANK_PAGE for an id the store has never seen, never undefined. */
  get(id: string): PageState;
  update(id: string, patch: Partial<PageState>): void;
  subscribe(id: string, cb: () => void): () => void;
  drop(id: string): void;
};

/**
 * `get` answers with the new state as soon as `update` returns; subscribers
 * hear about it once per `schedule`, however many events came in between.
 */
export function createPageStore(schedule: (flush: () => void) => void = nextFrame): PageStore {
  const states = new Map<string, PageState>();
  const listeners = new Map<string, Set<() => void>>();
  let dirty = new Set<string>();
  let scheduled = false;

  function flush() {
    // Swap first, so an update made by a subscriber lands in the next flush.
    scheduled = false;
    const ids = dirty;
    dirty = new Set();
    for (const id of ids) {
      const set = listeners.get(id);
      if (!set) continue;
      // A copy, because a subscriber may unsubscribe itself or another one.
      for (const cb of [...set]) if (set.has(cb)) cb();
    }
  }

  const get = (id: string) => states.get(id) ?? BLANK_PAGE;

  return {
    get,
    update(id, patch) {
      const current = get(id);
      if (!changes(current, patch)) return;
      states.set(id, { ...current, ...patch });
      dirty.add(id);
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
    },
    subscribe(id, cb) {
      const set = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, set);
      set.add(cb);
      return () => {
        set.delete(cb);
        // A drop and a fresh subscribe may have replaced this set; leave the new one alone.
        if (set.size === 0 && listeners.get(id) === set) listeners.delete(id);
      };
    },
    drop(id) {
      states.delete(id);
      dirty.delete(id);
      // Cleared as well as removed, so a flush already walking it stops calling.
      listeners.get(id)?.clear();
      listeners.delete(id);
    },
  };
}

function changes(current: PageState, patch: Partial<PageState>): boolean {
  for (const key of Object.keys(patch) as (keyof PageState)[]) {
    const next = patch[key];
    if (key === "error" ? !sameError(current.error, next as LoadError | null) : current[key] !== next) return true;
  }
  return false;
}

/** Each `did-fail-load` builds a new object, and a retry that fails the same way is no change. */
function sameError(a: LoadError | null, b: LoadError | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.code === b.code && a.description === b.description && a.url === b.url;
}

function nextFrame(flush: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => flush());
  else queueMicrotask(flush);
}

/** Every browser page's live state, flushed once per frame. */
export const pages: PageStore = createPageStore();
