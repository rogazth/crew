import { client } from "./client";
import { applyEvent, type Block, type HarnessEvent } from "./blocks";
import type { TranscriptApply, TranscriptSnapshot } from "./protocol";

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
  seq: number;
  snapshot: ThreadSnapshot;
  loading: Promise<void> | null;
  listeners: Set<() => void>;
  frame: number | null;
};

const EMPTY: ThreadSnapshot = { blocks: [], ready: false, working: false };

const threads = new Map<string, Thread>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("transcript-apply", (payload) => {
    const apply = payload as TranscriptApply;
    applyRemote(apply.sessionId, apply.seq, apply.event);
  });
  client.onReconnect(() => {
    for (const [id, row] of threads) {
      if (row.ready) void reload(id);
    }
  });
}

function thread(id: string): Thread {
  let row = threads.get(id);
  if (!row) {
    row = {
      blocks: [],
      ready: false,
      working: false,
      seq: 0,
      snapshot: EMPTY,
      loading: null,
      listeners: new Set(),
      frame: null,
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
  ensureBridge();
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
  ensureBridge();
  const row = thread(id);
  if (row.ready) return Promise.resolve();
  if (row.loading) return row.loading;
  row.loading = reload(id);
  return row.loading;
}

export async function reload(id: string): Promise<void> {
  ensureBridge();
  const row = thread(id);
  try {
    const snap = await client.request<TranscriptSnapshot>("transcript_get", { sessionId: id });
    row.blocks = snap.blocks;
    row.working = snap.working;
    row.seq = snap.seq;
  } catch {
    /* keep whatever we already have */
  }
  row.ready = true;
  row.loading = null;
  publish(row);
}

export function apply(id: string, event: HarnessEvent): void {
  const row = thread(id);
  row.blocks = applyEvent(row.blocks, event);
  schedule(row);
}

function applyRemote(id: string, seq: number, event: HarnessEvent): void {
  const row = threads.get(id);
  if (!row?.ready) return;
  if (seq !== row.seq + 1) {
    void reload(id);
    return;
  }
  row.seq = seq;
  row.blocks = applyEvent(row.blocks, event);
  schedule(row);
}

export function append(id: string, block: Block): void {
  const row = thread(id);
  row.blocks = [...row.blocks, block];
  schedule(row);
}

export function setWorking(id: string, working: boolean): void {
  const row = thread(id);
  if (row.working === working) return;
  row.working = working;
  schedule(row);
}

export function forget(id: string): void {
  const row = threads.get(id);
  if (!row) return;
  if (row.frame !== null) window.cancelAnimationFrame(row.frame);
  threads.delete(id);
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
