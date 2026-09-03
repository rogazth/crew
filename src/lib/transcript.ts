import { getSessionBlocks, setSessionBlocks } from "./api";
import { applyEvent, parseBlocks, settleTurn, type Block, type HarnessEvent } from "./blocks";

/** What a chat surface reads. One object per session; a new one each publish. */
export type ThreadSnapshot = {
  blocks: Block[];
  ready: boolean;
  working: boolean;
};

type Thread = {
  blocks: Block[];
  ready: boolean;
  working: boolean;
  snapshot: ThreadSnapshot;
  loading: Promise<void> | null;
  listeners: Set<() => void>;
  frame: number | null;
  saveTimer: number | null;
  dirty: boolean;
};

const SAVE_MS = 600;
const EMPTY: ThreadSnapshot = { blocks: [], ready: false, working: false };

const threads = new Map<string, Thread>();

function thread(id: string): Thread {
  let row = threads.get(id);
  if (!row) {
    row = {
      blocks: [],
      ready: false,
      working: false,
      snapshot: EMPTY,
      loading: null,
      listeners: new Set(),
      frame: null,
      saveTimer: null,
      dirty: false,
    };
    threads.set(id, row);
  }
  return row;
}

/**
 * The runtime keeps writing while the tab is closed, so a subscriber must not
 * be the thing that owns the list. Publishing is coalesced per frame: a turn
 * streams a line per token and the surface only needs one paint each.
 */
export function subscribe(id: string, listener: () => void): () => void {
  const row = thread(id);
  row.listeners.add(listener);
  return () => {
    row.listeners.delete(listener);
  };
}

export function read(id: string): ThreadSnapshot {
  return threads.get(id)?.snapshot ?? EMPTY;
}

export function isReady(id: string): boolean {
  return threads.get(id)?.ready ?? false;
}

export function load(id: string): Promise<void> {
  const row = thread(id);
  if (row.ready) return Promise.resolve();
  if (row.loading) return row.loading;
  row.loading = getSessionBlocks(id)
    .then((raw) => {
      row.blocks = settleTurn(parseBlocks(raw), "interrupted");
    })
    .catch(() => undefined)
    .then(() => {
      row.ready = true;
      row.loading = null;
      publish(row);
    });
  return row.loading;
}

export function apply(id: string, event: HarnessEvent): void {
  const row = thread(id);
  row.blocks = applyEvent(row.blocks, event);
  touch(id, row);
  if (
    event.type === "message.completed" ||
    event.type === "turn.completed" ||
    event.type === "session.error" ||
    event.type === "session.ended"
  ) {
    flush(id);
  }
}

export function append(id: string, block: Block): void {
  const row = thread(id);
  row.blocks = [...row.blocks, block];
  touch(id, row);
}

export function settle(id: string): void {
  const row = thread(id);
  row.blocks = settleTurn(row.blocks, "interrupted");
  touch(id, row);
}

export function setWorking(id: string, working: boolean): void {
  const row = thread(id);
  if (row.working === working) return;
  row.working = working;
  schedule(row);
}

export function flush(id: string): void {
  const row = threads.get(id);
  if (!row || !row.dirty) return;
  if (row.saveTimer !== null) window.clearTimeout(row.saveTimer);
  row.saveTimer = null;
  row.dirty = false;
  void setSessionBlocks(id, JSON.stringify(row.blocks)).catch(() => {});
}

export function forget(id: string): void {
  const row = threads.get(id);
  if (!row) return;
  if (row.saveTimer !== null) window.clearTimeout(row.saveTimer);
  if (row.frame !== null) window.cancelAnimationFrame(row.frame);
  threads.delete(id);
}

function touch(id: string, row: Thread): void {
  row.dirty = true;
  if (row.saveTimer === null) {
    row.saveTimer = window.setTimeout(() => {
      row.saveTimer = null;
      flush(id);
    }, SAVE_MS);
  }
  schedule(row);
}

function schedule(row: Thread): void {
  if (row.frame !== null) return;
  row.frame = window.requestAnimationFrame(() => {
    row.frame = null;
    publish(row);
  });
}

function publish(row: Thread): void {
  row.snapshot = { blocks: row.blocks, ready: row.ready, working: row.working };
  for (const listener of row.listeners) listener();
}
