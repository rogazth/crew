import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A daemon that pushes every terminal's output live to a window that has
 * attached one before, and replays a terminal's ring from `from` on attach.
 * Frames for a stream nobody opened yet are held, as `Connection` does.
 */
const daemon = vi.hoisted(() => {
  const encoder = new TextEncoder();
  const handlers = new Map<number, (bytes: Uint8Array) => void>();
  const held = new Map<number, Uint8Array[]>();
  const closed = new Set<number>();
  /** The live process of each terminal id: its stream and everything it printed. */
  const live = new Map<string, { stream: number; ring: Uint8Array }>();
  const spawns: Array<{ id: string; resolve: (stream: number) => void }> = [];
  let nextStream = 1;

  const push = (stream: number, bytes: Uint8Array) => {
    if (closed.has(stream)) return;
    const handler = handlers.get(stream);
    if (handler) handler(bytes);
    else held.set(stream, [...(held.get(stream) ?? []), bytes]);
  };

  return {
    spawns,
    reset() {
      handlers.clear();
      held.clear();
      closed.clear();
      live.clear();
      spawns.length = 0;
      nextStream = 1;
    },
    /** Starts a process for `id` that prints `text` at once, and answers the spawn when told to. */
    start(id: string, text: string): number {
      const stream = nextStream++;
      const ring = encoder.encode(text);
      live.set(id, { stream, ring });
      push(stream, ring);
      return stream;
    },
    client: {
      request: vi.fn((method: string, params: { id: string; from?: number }) => {
        if (method === "pty_spawn") return new Promise((resolve) => spawns.push({ id: params.id, resolve }));
        if (method === "pty_attach") {
          const process = live.get(params.id);
          if (!process) return Promise.reject(new Error("Terminal is not running"));
          const from = Math.min(params.from ?? 0, process.ring.byteLength);
          push(process.stream, process.ring.subarray(from));
          return Promise.resolve({ start: from, emitted: process.ring.byteLength });
        }
        if (method === "pty_kill") {
          live.delete(params.id);
          return Promise.resolve();
        }
        return Promise.resolve();
      }),
      on: vi.fn(() => () => {}),
      onReconnect: vi.fn(() => () => {}),
      openStream(stream: number, onBytes: (bytes: Uint8Array) => void) {
        closed.delete(stream);
        handlers.set(stream, onBytes);
        for (const bytes of held.get(stream) ?? []) onBytes(bytes);
        held.delete(stream);
        return () => {
          handlers.delete(stream);
          closed.add(stream);
        };
      },
      writeStream: vi.fn(() => Promise.resolve()),
    },
  };
});

vi.mock("./client", () => ({ client: daemon.client }));

import { killPty, spawnPty, subscribePty } from "./pty";

const decoder = new TextDecoder();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function screen() {
  let text = "";
  return {
    write: (bytes: Uint8Array) => {
      text += decoder.decode(bytes);
    },
    get text() {
      return text;
    },
  };
}

describe("a terminal's first output", () => {
  beforeEach(() => daemon.reset());

  it("shows once after a spawn", async () => {
    const pane = screen();
    subscribePty("ws/stub:terminal", pane.write, () => {});
    const spawned = spawnPty("ws/stub:terminal", "/home/me", [], 80, 24);
    daemon.spawns[0]!.resolve(daemon.start("ws/stub:terminal", "me$ "));
    await spawned;
    await flush();
    expect(pane.text).toBe("me$ ");
  });

  // StrictMode mounts every new terminal twice: spawn, kill, spawn, with the
  // first spawn answering after the pane that sent it is gone.
  it("shows once when the pane is torn down and remade while its spawn is in flight", async () => {
    const id = "ws/stub:terminal";
    const first = screen();
    const stopFirst = subscribePty(id, first.write, () => {});
    const firstSpawn = spawnPty(id, "/home/me", [], 80, 24);
    stopFirst();
    void killPty(id);
    const second = screen();
    subscribePty(id, second.write, () => {});
    const secondSpawn = spawnPty(id, "/home/me", [], 80, 24);

    // The daemon runs them in order: the first process prints, is killed, the second prints.
    const firstStream = daemon.start(id, "first$ ");
    const secondStream = daemon.start(id, "second$ ");
    daemon.spawns[0]!.resolve(firstStream);
    await firstSpawn;
    await flush();
    daemon.spawns[1]!.resolve(secondStream);
    await secondSpawn;
    await flush();

    expect(second.text).toBe("second$ ");
    expect(first.text).toBe("");
  });
});
