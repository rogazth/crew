import { client } from "./client";
import type { PtyAttached, PtyError, PtyExit } from "./protocol";

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
    if (attachHandlers.get(id) === onAttach) attachHandlers.delete(id);
    // A later subscriber for the same session owns the stream now.
    if (dataHandlers.get(id) !== onData) return;
    dataHandlers.delete(id);
    streams.get(id)?.stop();
    streams.delete(id);
    delivered.delete(id);
  };
}

export async function spawnPty(
  id: string,
  cwd: string,
  command: string[],
  cols: number,
  rows: number,
): Promise<number> {
  const streamId = await client.request<number>("pty_spawn", { id, cwd, command, cols, rows });
  // Wire the stream before the replay: the process is already running, so a
  // rejection here would strand it with no way to reach it again.
  const onData = dataHandlers.get(id);
  if (onData) attach(id, streamId, onData);
  else streams.set(id, { id: streamId, stop: () => {} });
  await applyAttach(id, delivered.get(id) ?? 0).catch(() => {});
  return streamId;
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
