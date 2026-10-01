import { client } from "./client";
import type { PtyAttached, PtyError, PtyExit, PtySpawn } from "./protocol";
import { markRunning, markStopped, sessionOfPty } from "./runningSessions";

const encoder = new TextEncoder();
const dataHandlers = new Map<string, (bytes: Uint8Array) => void>();
const attachHandlers = new Map<string, (start: number) => void>();
const streams = new Map<string, { id: number; stop: () => void }>();
const delivered = new Map<string, number>();
/** Bumped by every spawn and kill: a spawn that answers after a newer one, or after its kill, is stale. */
const generations = new Map<string, number>();
let reconnectHook: (() => void) | null = null;

function ensureReconnect() {
  if (reconnectHook) return;
  reconnectHook = client.onReconnect((here = () => true) => {
    for (const [id] of streams) {
      if (here(id)) void applyAttach(id, delivered.get(id) ?? 0).catch(() => {});
    }
  });
}

async function applyAttach(id: string, from: number): Promise<void> {
  const attached = await client.request<PtyAttached>("pty_attach", { id, from });
  delivered.set(id, attached.start);
  attachHandlers.get(id)?.(attached.start);
}

function attach(sessionId: string, streamId: number, onData: (bytes: Uint8Array) => void, replay = true) {
  streams.get(sessionId)?.stop();
  const wrapped = (bytes: Uint8Array) => {
    delivered.set(sessionId, (delivered.get(sessionId) ?? 0) + bytes.byteLength);
    onData(bytes);
  };
  streams.set(sessionId, { id: streamId, stop: client.openStream(streamId, wrapped, sessionId, replay) });
}

/**
 * Every PTY shares one event bus, so each terminal filters by id. The daemon
 * sends a stream's bytes only once it is attached, from the offset asked for.
 * Spawn after subscribing so the exit listener is already attached.
 */
export function subscribePty(
  id: string,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number | null) => void,
  onAttach?: (start: number) => void,
): () => void {
  ensureReconnect();
  dataHandlers.set(id, onData);
  if (onAttach) attachHandlers.set(id, onAttach);
  const existing = streams.get(id);
  if (existing) attach(id, existing.id, onData);
  const stopExit = client.on("pty-exit", (payload) => {
    const event = payload as PtyExit;
    if (event.id === id) onExit(event.code);
  });
  const stopError = client.on("pty-error", (payload) => {
    const event = payload as PtyError;
    if (event.id === id) onExit(null);
  });
  return () => {
    stopExit();
    stopError();
    if (dataHandlers.get(id) === onData) dataHandlers.delete(id);
    if (attachHandlers.get(id) === onAttach) attachHandlers.delete(id);
    streams.get(id)?.stop();
    streams.delete(id);
    delivered.delete(id);
  };
}

export type SpawnOptions = {
  /**
   * The terminal session the process runs, if any: the daemon then hands it a
   * token and the provider's MCP flag, so the CLI reaches Crew's tools. Left
   * out for a plain shell.
   */
  session?: string;
  /** Keep a process still running under this id: a window opening again finds it. */
  reuse?: boolean;
  /** Whether the window paints the terminal dark, for COLORFGBG. */
  dark?: boolean;
};

export async function spawnPty(
  id: string,
  cwd: string,
  command: string[],
  cols: number,
  rows: number,
  options: SpawnOptions = {},
): Promise<number> {
  const { session, reuse = false, dark } = options;
  const generation = (generations.get(id) ?? 0) + 1;
  generations.set(id, generation);
  const params: PtySpawn = { id, cwd, command, cols, rows, reuse, ...(dark === undefined ? {} : { dark }), ...(session ? { session } : {}) };
  const streamId = await client.request<number>("pty_spawn", params);
  const owner = session ? sessionOfPty(id) : null;
  if (owner) markRunning(owner.session, owner.workspace);
  if (generations.get(id) !== generation) {
    // The pane was torn down (or respawned) while this spawn was in flight, as
    // StrictMode does to every new terminal. Its process is killed, replaced or
    // let go already; wiring it would write its output into the pane that
    // replaced it.
    client.openStream(streamId, () => {}, id)();
    return streamId;
  }
  await attachPty(id, streamId);
  return streamId;
}

/**
 * Watch a PTY someone else started, a supervised process's, as `spawnPty`
 * watches its own: subscribe first, then this.
 */
export async function attachPty(id: string, streamId: number): Promise<void> {
  // A new stream (a respawn, a restarted process) counts from its own first
  // byte; only the same stream goes on from what this view already has.
  if (streams.get(id)?.id !== streamId) delivered.set(id, 0);
  // Wire the stream before the replay: the process is already running, so a
  // rejection here would strand it with no way to reach it again. Anything
  // buffered for it is dropped: it starts wherever the frames did, not at
  // `from`, and the ring's replay has those bytes in their place.
  const onData = dataHandlers.get(id);
  if (onData) attach(id, streamId, onData, false);
  else streams.set(id, { id: streamId, stop: () => {} });
  await applyAttach(id, delivered.get(id) ?? 0).catch(() => {});
}

/** After a `pty-resync`: this viewer's frames were dropped, so it repaints from the ring. */
export function reattachPty(id: string): Promise<void> {
  delivered.set(id, 0);
  return applyAttach(id, 0);
}

/**
 * The bytes a viewer's xterm has parsed, for `pty_ack`, across resyncs. A
 * resync resets the count to where the replay starts, but xterm still holds
 * writes queued before it, and their callbacks come after: counted, they would
 * ack past what the view has and let the daemon send more than it can take.
 * Each write is stamped with the generation it belongs to; a resync starts a
 * new one.
 */
export function parsedCount() {
  let processed = 0;
  let generation = 0;
  return {
    get processed() {
      return processed;
    },
    /** Call before `term.write`; the callback it returns goes to xterm. True if it counted. */
    write(bytes: number): () => boolean {
      const mine = generation;
      return () => {
        if (mine !== generation) return false;
        processed += bytes;
        return true;
      };
    },
    /** What was queued before this no longer counts. */
    resync(): void {
      generation += 1;
    },
    /** The attach answered: the replay starts here. */
    attached(start: number): void {
      processed = start;
    },
  };
}

export function writePty(id: string, data: string): Promise<void> {
  const stream = streams.get(id);
  if (stream) return client.writeStream(stream.id, encoder.encode(data), id);
  return client.request("pty_write", { id, data });
}

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  client.request("pty_resize", { id, cols, rows });

export const ackPty = (id: string, processed: number): Promise<void> =>
  client.request("pty_ack", { id, processed });

/** Stops watching `id`: a spawn still in flight is stale, and its frames go nowhere. */
function release(id: string) {
  generations.set(id, (generations.get(id) ?? 0) + 1);
  streams.get(id)?.stop();
  streams.delete(id);
  dataHandlers.delete(id);
  attachHandlers.delete(id);
  delivered.delete(id);
}

/** The process of `id` ended, whether or not a pane watches it. */
export function onPtyExit(id: string, onExit: (code: number | null) => void): () => void {
  return client.on("pty-exit", (payload) => {
    const event = payload as PtyExit;
    if (event.id === id) onExit(event.code);
  });
}

export const killPty = (id: string): Promise<void> => {
  release(id);
  const owner = sessionOfPty(id);
  if (owner) markStopped(owner.session);
  return client.request("pty_kill", { id });
};

/**
 * Lets go of `id` and leaves its process running: crewd keeps its output in
 * the ring, and the next `spawnPty` with `reuse` attaches to it again.
 */
export const detachPty = (id: string): Promise<void> => {
  release(id);
  return client.request("pty_detach", { id });
};
