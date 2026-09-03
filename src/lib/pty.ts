import { listen } from "@tauri-apps/api/event";

type PtyData = { id: string; data: string };
type PtyExit = { id: string; code: number | null };

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Every PTY shares one event bus, so each terminal filters by id. Both
 * listeners are attached before the first data event can arrive: `listen`
 * resolves later, so `data` events emitted before that are lost. Spawn after
 * subscribing, never before.
 */
export function subscribePty(
  id: string,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number | null) => void,
): () => void {
  let disposed = false;
  const stops: Array<() => void> = [];
  const keep = (promise: Promise<() => void>) => {
    void promise.then((stop) => {
      if (disposed) stop();
      else stops.push(stop);
    });
  };
  keep(
    listen<PtyData>("pty-data", (event) => {
      if (event.payload.id === id) onData(decode(event.payload.data));
    }),
  );
  keep(
    listen<PtyExit>("pty-exit", (event) => {
      if (event.payload.id === id) onExit(event.payload.code);
    }),
  );
  return () => {
    disposed = true;
    for (const stop of stops) stop();
  };
}
