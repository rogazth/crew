import { client } from "./client";
import type { Block } from "./blocks";
import type { HistoryState, SessionHistoryAppended, SessionHistoryWindow } from "./protocol";
import { isUnknownMethod } from "./sessionLive";

/**
 * A session's conversation as its CLI keeps it, read back by the daemon that
 * runs it. The daemon reads the file only while some chat holds it open, and
 * pushes what the CLI appends; this keeps the window each chat shows.
 */

export type HistorySnapshot = {
  blocks: Block[];
  /** Nothing asked yet, or the first window is on its way. */
  loading: boolean;
  state: HistoryState;
  error: string | null;
  more: boolean;
  loadingEarlier: boolean;
};

type Entry = {
  cwd: string;
  blocks: Block[];
  /** The index of `blocks[0]` in the daemon's reading. */
  start: number;
  snapshot: HistorySnapshot;
  holders: number;
  listeners: Set<() => void>;
  /** Bumped per window request, so a slow answer does not land over a newer one. */
  generation: number;
};

const LOADING: HistorySnapshot = {
  blocks: [],
  loading: true,
  state: "pending",
  error: null,
  more: false,
  loadingEarlier: false,
};

const entries = new Map<string, Entry>();
let hooked = false;

function ensureBridge() {
  if (hooked) return;
  hooked = true;
  client.on("session-history-appended", (payload) => onAppended(payload as SessionHistoryAppended));
  client.onReconnect((here = () => true) => {
    for (const [id, entry] of entries) if (here(id) && entry.holders > 0) void reload(id);
  });
}

function publish(entry: Entry, patch: Partial<HistorySnapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch, blocks: entry.blocks };
  for (const listener of entry.listeners) listener();
}

function onAppended(event: SessionHistoryAppended) {
  const entry = entries.get(event.sessionId);
  if (!entry || entry.snapshot.loading) return;
  if (event.reset || event.from < entry.start) {
    void reload(event.sessionId);
    return;
  }
  entry.blocks = [...entry.blocks.slice(0, event.from - entry.start), ...event.blocks];
  publish(entry, { state: event.state, error: event.state === "error" ? entry.snapshot.error : null });
}

async function reload(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry) return;
  const generation = ++entry.generation;
  try {
    const window = await client.request<SessionHistoryWindow>("session_history_window", { id, cwd: entry.cwd });
    if (entry.generation !== generation) return;
    entry.blocks = window.blocks;
    entry.start = window.start;
    publish(entry, { loading: false, state: window.state, error: window.error ?? null, more: window.more });
  } catch (error) {
    if (entry.generation !== generation) return;
    const message = isUnknownMethod(error)
      ? "This machine's crewd is older than the app and can't read conversations. Update it in Settings › Environments."
      : error instanceof Error
        ? error.message
        : String(error);
    publish(entry, { loading: false, state: "error", error: message });
  }
}

function entryOf(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = { cwd: "", blocks: [], start: 0, snapshot: LOADING, holders: 0, listeners: new Set(), generation: 0 };
    entries.set(id, entry);
  }
  return entry;
}

/** Holds `id`'s history open while the returned function is not called. */
export function holdHistory(id: string, cwd: string): () => void {
  ensureBridge();
  const entry = entryOf(id);
  entry.holders += 1;
  if (entry.holders === 1) {
    entry.cwd = cwd;
    void reload(id);
  }
  const held = entry;
  return () => {
    held.holders -= 1;
    if (held.holders > 0) return;
    // Closed: the daemon stops reading, and the next open reads afresh.
    held.generation += 1;
    held.snapshot = LOADING;
    held.blocks = [];
    void client.request("session_history_close", { id }).catch(() => {});
  };
}

export function subscribeHistory(id: string, listener: () => void): () => void {
  ensureBridge();
  const entry = entryOf(id);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function readHistory(id: string): HistorySnapshot {
  return entries.get(id)?.snapshot ?? LOADING;
}

/** The page before the one in hand, prepended. */
export async function loadEarlierHistory(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry || entry.snapshot.loading || !entry.snapshot.more || entry.snapshot.loadingEarlier) return;
  publish(entry, { loadingEarlier: true });
  const generation = entry.generation;
  try {
    const window = await client.request<SessionHistoryWindow>("session_history_window", {
      id,
      cwd: entry.cwd,
      before: entry.start,
    });
    if (entry.generation !== generation) return;
    entry.blocks = [...window.blocks, ...entry.blocks];
    entry.start = window.start;
    publish(entry, { loadingEarlier: false, more: window.more });
  } catch {
    publish(entry, { loadingEarlier: false });
  }
}
