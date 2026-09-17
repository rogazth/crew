import { client } from "./client";
import { applyEvent, type Block, type HarnessEvent } from "./blocks";
import type { MessagePage, TranscriptApply } from "./protocol";

/**
 * How many blocks a chat opens with. A year of conversation is not something a
 * window has to hold to be useful, and a screenful is what the reader sees
 * before the scroller asks for the page behind it.
 */
const PAGE = 80;

/** What a chat surface reads. One object per session; a new one each publish. */
export type ThreadSnapshot = {
  blocks: Block[];
  ready: boolean;
  working: boolean;
  /** Older blocks exist before the first one held here. */
  more: boolean;
  loadingEarlier: boolean;
  /** The last block a search hit sent the reader to. Kept, not consumed: the
   *  chat scrolls to it once and leaves it marked. */
  focusId: string | null;
};

type Thread = {
  blocks: Block[];
  ready: boolean;
  working: boolean;
  seq: number;
  /** Position of `blocks[0]` in the daemon's transcript, 1-based. */
  fromPos: number;
  more: boolean;
  loadingEarlier: boolean;
  focusId: string | null;
  snapshot: ThreadSnapshot;
  loading: Promise<void> | null;
  listeners: Set<() => void>;
  frame: number | null;
};

const EMPTY: ThreadSnapshot = {
  blocks: [],
  ready: false,
  working: false,
  more: false,
  loadingEarlier: false,
  focusId: null,
};

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
      fromPos: 0,
      more: false,
      loadingEarlier: false,
      focusId: null,
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
  const held = row.fromPos;
  try {
    const page = await client.request<MessagePage>("transcript_tail", { sessionId: id, limit: PAGE });
    take(row, page);
  } catch {
    /* keep whatever we already have */
  }
  row.ready = true;
  row.loading = null;
  publish(row);
  // Walk back to the history the reader had opened. Asking for it in one page
  // does not work: the daemon caps a window, and silently handing back less
  // than was asked for is what throws them out of what they were reading.
  for (let page = 0; page < FOCUS_PAGES && row.fromPos > held && held > 0 && row.more; page += 1) {
    await loadEarlier(id);
  }
}

function take(row: Thread, page: MessagePage): void {
  row.blocks = page.blocks;
  row.working = page.working;
  row.seq = page.seq;
  // An empty page has no first block to report a position for, and the thread
  // then grows from live events alone: the next block lands at 1, and leaving
  // this at 0 puts every later position one line out.
  row.fromPos = page.fromPos > 0 ? page.fromPos : page.toPos + 1;
  row.more = page.more;
}

/** How many pages back a search hit — or a resync — is worth chasing. */
const FOCUS_PAGES = 5;

/**
 * Take the reader to a block by its position, loading history until it is in
 * hand. A hit from a year ago is not worth walking a year of pages for, so this
 * gives up after a few and leaves them at the oldest page it reached.
 */
export async function focus(id: string, pos: number): Promise<void> {
  await load(id);
  const row = threads.get(id);
  if (!row) return;
  for (let page = 0; page < FOCUS_PAGES && row.fromPos > pos && row.more; page += 1) {
    await loadEarlier(id);
  }
  row.focusId = row.blocks[pos - row.fromPos]?.id ?? null;
  publish(row);
}

/** The page before the one in hand, prepended. */
export async function loadEarlier(id: string): Promise<void> {
  const row = threads.get(id);
  if (!row || !row.ready || !row.more || row.loadingEarlier) return;
  row.loadingEarlier = true;
  publish(row);
  try {
    const page = await client.request<MessagePage>("transcript_tail", {
      sessionId: id,
      limit: PAGE,
      beforePos: row.fromPos,
    });
    // A turn that landed while this was in flight only appended, so the older
    // page still sits in front of what is here.
    row.blocks = [...page.blocks, ...row.blocks];
    row.fromPos = page.fromPos;
    row.more = page.more;
  } catch {
    /* the button stays; the reader can try again */
  }
  row.loadingEarlier = false;
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
  row.snapshot = {
    blocks: row.blocks,
    ready: row.ready,
    working: row.working,
    more: row.more,
    loadingEarlier: row.loadingEarlier,
    focusId: row.focusId,
  };
  for (const listener of row.listeners) listener();
}
