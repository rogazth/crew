import { client } from "./client";
import type { PtyAttached, PtyError, PtyExit, PtySpawn } from "./protocol";

const encoder = new TextEncoder();
const dataHandlers = new Map<string, (bytes: Uint8Array) => void>();
const attachHandlers = new Map<string, (start: number) => void>();
const streams = new Map<string, { id: number; stop: () => void }>();
const delivered = new Map<string, number>();
let reconnectHook: (() => void) | null = null;

function ensureReconnect() {
  if (reconnectHook) return;
  reconnectHook = client.onReconnect(() => {
    for (const [id] of streams) {
      void applyAttach(id, delivered.get(id) ?? 0).catch(() => {});
    }
  });
}

async function applyAttach(id: string, from: number): Promise<void> {
  const attached = await client.request<PtyAttached>("pty_attach", { id, from });
  delivered.set(id, attached.start);
  attachHandlers.get(id)?.(attached.start);
}

function attach(sessionId: string, streamId: number, onData: (bytes: Uint8Array) => void) {
  streams.get(sessionId)?.stop();
  const wrapped = (bytes: Uint8Array) => {
    delivered.set(sessionId, (delivered.get(sessionId) ?? 0) + bytes.byteLength);
    onData(bytes);
  };
  streams.set(sessionId, { id: streamId, stop: client.openStream(streamId, wrapped) });
}

/**
 * Every PTY shares one event bus, so each terminal filters by id. Stream bytes
 * that arrive before `openStream` are buffered by the client. Spawn after
 * subscribing so the exit listener is already attached.
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

/**
 * `session` is the terminal session the process runs, if any: the daemon then
 * hands it a token and the provider's MCP flag, so the CLI reaches Crew's
 * tools. Left out for a plain shell.
 */
export async function spawnPty(
  id: string,
  cwd: string,
  command: string[],
  cols: number,
  rows: number,
  session?: string,
): Promise<number> {
  const params: PtySpawn = { id, cwd, command, cols, rows, ...(session ? { session } : {}) };
  const streamId = await client.request<number>("pty_spawn", params);
  await attachPty(id, streamId);
  return streamId;
}

/**
 * Watch a PTY someone else started, a supervised process's, as `spawnPty`
 * watches its own: subscribe first, then this.
 */
export async function attachPty(id: string, streamId: number): Promise<void> {
  // Wire the stream before the replay: the process is already running, so a
  // rejection here would strand it with no way to reach it again.
  const onData = dataHandlers.get(id);
  if (onData) attach(id, streamId, onData);
  else streams.set(id, { id: streamId, stop: () => {} });
  await applyAttach(id, delivered.get(id) ?? 0).catch(() => {});
}

/** After a `pty-resync`: this viewer's frames were dropped, so it repaints from the ring. */
export function reattachPty(id: string): Promise<void> {
  delivered.set(id, 0);
  return applyAttach(id, 0);
}

export function writePty(id: string, data: string): Promise<void> {
  const stream = streams.get(id);
  if (stream) return client.writeStream(stream.id, encoder.encode(data));
  return client.request("pty_write", { id, data });
}

export const resizePty = (id: string, cols: number, rows: number): Promise<void> =>
  client.request("pty_resize", { id, cols, rows });

export const ackPty = (id: string, processed: number): Promise<void> =>
  client.request("pty_ack", { id, processed });

export const killPty = (id: string): Promise<void> => {
  streams.get(id)?.stop();
  streams.delete(id);
  dataHandlers.delete(id);
  attachHandlers.delete(id);
  delivered.delete(id);
  return client.request("pty_kill", { id });
};
