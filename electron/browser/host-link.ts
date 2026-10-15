/**
 * Main's own connection to a crewd, as a browser host: this Mac's, or a
 * remote machine's. The window's socket is the renderer's and dies with a
 * reload; this one lives with the app. crewd sends it `browser-call` events
 * and it answers each with `browser_result`, after a `browser_ack` the moment
 * the call arrives. It also hears `browser-leases`, which is when a tab
 * nobody drives any more lets go of the debugger.
 */

import type { AgentTools, BrowserCall, Content } from "./agent-tools";

export type DaemonInfo = { url: string; token: string };

type Leases = { seq?: number; leases: { tab: string }[] };

export type Hello = { name: string; acks: boolean };

export type HostLink = {
  /** A request on this connection; rejects when it is down or the daemon refuses. */
  request<T>(method: string, params?: object): Promise<T>;
  /** Registered and listening. */
  ready(): boolean;
  /** Drops the connection now and dials again (a Mac that woke, a machine that came back). */
  redial(): void;
  /** Closes the connection and stays closed until `redial` (a Mac going to sleep). */
  pause(): void;
  stop(): void;
};

type Options = {
  /** Read on every connect: a restarted daemon has a new port and token. */
  info: () => DaemonInfo | null | Promise<DaemonInfo | null>;
  tools: AgentTools;
  hello: Hello;
  onLeases: (tabs: ReadonlySet<string>) => void;
  /** The call as it may run, or why it may not: a remote only drives its own tabs. */
  gate?: (call: BrowserCall) => BrowserCall | string | Promise<BrowserCall | string>;
  /** What the answer becomes before it is sent back (a smaller screenshot for a far machine). */
  shrink?: (result: Content[]) => Content[];
  /** Registered on a new connection. */
  onReady?: () => void;
  /** Any other event the daemon sends. */
  onEvent?: (event: string, payload: unknown) => void;
  /** Milliseconds before dialing again after the `attempt`th failure in a row. */
  backoff?: (attempt: number) => number;
};

const RETRY_MS = 1000;
const REQUEST_MS = 10_000;

/**
 * Hands on the leased tabs of each list crewd sends, skipping any older than
 * one already handed on: the register reply and the events race each other,
 * and a stale list would detach the debugger from a tab an agent now drives.
 */
export function leaseFeed(onLeases: (tabs: ReadonlySet<string>) => void): (value: unknown) => void {
  let newest = Number.NEGATIVE_INFINITY;
  return (value) => {
    const all = value as Leases | null;
    if (!Array.isArray(all?.leases)) return;
    if (typeof all.seq === "number") {
      if (all.seq < newest) return;
      newest = all.seq;
    }
    onLeases(new Set(all.leases.map((lease) => lease.tab)));
  };
}

/**
 * The call with its deadline on this Mac's clock. crewd's own deadline is on
 * its clock, which on another machine may be seconds off; the budget it gives
 * is counted from when the call got here instead.
 */
export function onLocalClock(call: BrowserCall, now: number): BrowserCall {
  const budget = call.timeoutMs;
  return typeof budget === "number" && budget > 0 ? { ...call, deadline: now + budget } : call;
}

export function linkBrowserHost({ info, tools, hello, onLeases, gate, shrink, onReady, onEvent, backoff }: Options): HostLink {
  let socket: WebSocket | null = null;
  let registered = false;
  let stopped = false;
  let paused = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let nextId = 1;
  // Each dial's own number: a socket from before a redial must not act on the new one.
  let generation = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  // Fresh for each connection: order only matters within one daemon's lists.
  let leased = leaseFeed(onLeases);

  const send = (ws: WebSocket, method: string, params: object): number => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  };

  const answer = (ws: WebSocket, callId: number, outcome: { ok: true; result: Content[] } | { ok: false; error: string }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    send(ws, "browser_result", { callId, ...outcome });
  };

  const failWaiting = (why: string) => {
    for (const [id, pending] of waiting) {
      clearTimeout(pending.timer);
      pending.reject(new Error(why));
      waiting.delete(id);
    }
  };

  const schedule = () => {
    if (stopped || paused || retry !== undefined) return;
    const wait = backoff ? backoff(failures) : RETRY_MS;
    retry = setTimeout(connect, wait);
  };

  const connect = async () => {
    retry = undefined;
    if (stopped || paused) return;
    const mine = ++generation;
    const current = await Promise.resolve(info()).catch(() => null);
    if (stopped || paused || mine !== generation) return;
    if (!current) {
      failures++;
      return schedule();
    }
    const ws = new WebSocket(current.url);
    socket = ws;
    registered = false;
    leased = leaseFeed(onLeases);
    let registerId = 0;
    ws.onopen = () => {
      ws.send(JSON.stringify({ auth: current.token }));
      registerId = send(ws, "browser_host_register", hello);
    };
    ws.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      let parsed: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; payload?: unknown };
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (parsed.id !== undefined && parsed.id === registerId) {
        if (!parsed.ok) return;
        registered = true;
        failures = 0;
        leased(parsed.result);
        onReady?.();
        return;
      }
      if (parsed.id !== undefined && waiting.has(parsed.id)) {
        const pending = waiting.get(parsed.id)!;
        waiting.delete(parsed.id);
        clearTimeout(pending.timer);
        if (parsed.ok) pending.resolve(parsed.result);
        else pending.reject(new Error(parsed.error || "Request failed"));
        return;
      }
      if (parsed.event === "browser-leases") return leased(parsed.payload);
      if (parsed.event !== "browser-call") {
        if (parsed.event) onEvent?.(parsed.event, parsed.payload);
        return;
      }
      const call = onLocalClock(parsed.payload as BrowserCall, Date.now());
      // Said at once, so crewd can tell a Mac that is working from one that is not there.
      if (hello.acks) send(ws, "browser_ack", { callId: call.callId });
      Promise.resolve(gate ? gate(call) : call)
        .then((gated) => {
          if (typeof gated === "string") throw new Error(gated);
          return tools.run(gated);
        })
        .then(
          (result) => answer(ws, call.callId, { ok: true, result: shrink ? shrink(result) : result }),
          (error: unknown) => answer(ws, call.callId, { ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (mine !== generation) return;
      if (!registered) failures++;
      socket = null;
      registered = false;
      failWaiting("The connection closed");
      // crewd restarted, or is restarting: main's recovery hands out the new address.
      schedule();
    };
  };

  const drop = () => {
    generation++;
    if (retry) clearTimeout(retry);
    retry = undefined;
    const ws = socket;
    socket = null;
    registered = false;
    failWaiting("The connection closed");
    ws?.close();
  };

  void connect();
  return {
    request: <T>(method: string, params: object = {}) =>
      new Promise<T>((resolve, reject) => {
        const ws = socket;
        if (!ws || !registered || ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
        const id = send(ws, method, params);
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${method} timed out`));
        }, REQUEST_MS);
        waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      }),
    ready: () => registered,
    redial: () => {
      paused = false;
      failures = 0;
      drop();
      void connect();
    },
    pause: () => {
      paused = true;
      drop();
    },
    stop: () => {
      stopped = true;
      drop();
    },
  };
}
