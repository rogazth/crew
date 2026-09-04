import { client } from "./client";
import type { PtyExit } from "./protocol";

const encoder = new TextEncoder();
const dataHandlers = new Map<string, (bytes: Uint8Array) => void>();
const streams = new Map<string, { id: number; stop: () => void }>();

function attach(sessionId: string, streamId: number, onData: (bytes: Uint8Array) => void) {
  streams.get(sessionId)?.stop();
  streams.set(sessionId, { id: streamId, stop: client.openStream(streamId, onData) });
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
): () => void {
  dataHandlers.set(id, onData);
  const existing = streams.get(id);
  if (existing) attach(id, existing.id, onData);
  const stopExit = client.on("pty-exit", (payload) => {
    const event = payload as PtyExit;
    if (event.id === id) onExit(event.code);
  });
  return () => {
    stopExit();
    if (dataHandlers.get(id) === onData) dataHandlers.delete(id);
    streams.get(id)?.stop();
    streams.delete(id);
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
  const onData = dataHandlers.get(id);
  if (onData) attach(id, streamId, onData);
  else streams.set(id, { id: streamId, stop: () => {} });
  return streamId;
}

export function writePty(id: string, data: string): Promise<void> {
  const stream = streams.get(id);
  if (stream) {
    client.writeStream(stream.id, encoder.encode(data));
    return Promise.resolve();
  }
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
  return client.request("pty_kill", { id });
};
