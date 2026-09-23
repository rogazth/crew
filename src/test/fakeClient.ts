import { vi, type Mock } from "vitest";

type Listener = (payload: unknown) => void;
type Responder = (params: Record<string, unknown>) => unknown;

export type FakeRequest = {
  method: string;
  params: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/**
 * Stands in for `lib/client` (and so for everything in `lib/api`). Requests
 * with a responder answer on the next microtask; the rest wait in `requests`
 * until the test settles them. Install it in a test file with
 *
 *   vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));
 *
 * and call `fake.reset()` in `beforeEach`.
 */
function createFakeClient() {
  const requests: FakeRequest[] = [];
  const responders = new Map<string, Responder>();
  const listeners = new Map<string, Set<Listener>>();
  const reconnectHooks = new Set<() => void>();
  const streams = new Map<number, (bytes: Uint8Array) => void>();
  const writes: Array<{ id: number; bytes: Uint8Array }> = [];

  const request = vi.fn((method: string, params: object = {}): Promise<unknown> => {
    const args = params as Record<string, unknown>;
    const responder = responders.get(method);
    if (responder) return Promise.resolve().then(() => responder(args));
    return new Promise((resolve, reject) => {
      requests.push({ method, params: args, resolve, reject });
    });
  }) as Mock<(method: string, params?: object) => Promise<unknown>> &
    (<T>(method: string, params?: object) => Promise<T>);

  const client = {
    request,
    on: vi.fn((event: string, listener: Listener): (() => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    }),
    onReconnect: vi.fn((hook: () => void): (() => void) => {
      reconnectHooks.add(hook);
      return () => {
        reconnectHooks.delete(hook);
      };
    }),
    openStream: vi.fn((id: number, onBytes: (bytes: Uint8Array) => void): (() => void) => {
      streams.set(id, onBytes);
      return () => {
        if (streams.get(id) === onBytes) streams.delete(id);
      };
    }),
    writeStream: vi.fn((id: number, bytes: Uint8Array): Promise<void> => {
      writes.push({ id, bytes });
      return Promise.resolve();
    }),
  };

  return {
    client,
    /** Requests nobody has answered yet, oldest first. */
    requests,
    /** Bytes written to streams, in order. */
    writes,
    /** Answers every future `method` request with what `responder` returns (or throws). */
    respond(method: string, responder: Responder) {
      responders.set(method, responder);
    },
    /** The oldest unanswered `method` request; throws when there is none. */
    take(method: string): FakeRequest {
      const index = requests.findIndex((request) => request.method === method);
      const found = requests[index];
      if (!found) throw new Error(`no pending ${method} request`);
      requests.splice(index, 1);
      return found;
    },
    /** Every params object sent with `method`, answered or not. */
    sent(method: string): Array<Record<string, unknown>> {
      return client.request.mock.calls
        .filter(([name]) => name === method)
        .map(([, params]) => (params ?? {}) as Record<string, unknown>);
    },
    emit(event: string, payload: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    listening(event: string): number {
      return listeners.get(event)?.size ?? 0;
    },
    reconnect() {
      for (const hook of [...reconnectHooks]) hook();
    },
    push(id: number, bytes: Uint8Array) {
      streams.get(id)?.(bytes);
    },
    streamOpen(id: number): boolean {
      return streams.has(id);
    },
    reset() {
      requests.length = 0;
      writes.length = 0;
      responders.clear();
      listeners.clear();
      reconnectHooks.clear();
      streams.clear();
      for (const fn of Object.values(client)) fn.mockClear();
    },
  };
}

export const fake = createFakeClient();
export type FakeClient = typeof fake;
