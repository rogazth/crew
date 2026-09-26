/**
 * Main's own connection to crewd, as the browser host. The window's socket
 * is the renderer's and dies with a reload; this one lives with the app. crewd
 * sends it `browser-call` events and it answers each with `browser_result`.
 * It also hears `browser-leases`, which is when a tab nobody drives any more
 * lets go of the debugger.
 */

import type { AgentTools, BrowserCall, Content } from "./agent-tools";

type DaemonInfo = { url: string; token: string };

type Leases = { seq?: number; leases: { tab: string }[] };

type Options = {
  /** Read on every connect: a restarted daemon has a new port and token. */
  info: () => DaemonInfo | null;
  tools: AgentTools;
  onLeases: (tabs: ReadonlySet<string>) => void;
};

const RETRY_MS = 1000;

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

export function linkBrowserHost({ info, tools, onLeases }: Options): { stop(): void } {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  // Fresh for each connection: order only matters within one daemon's lists.
  let leased = leaseFeed(onLeases);

  const answer = (ws: WebSocket, callId: number, outcome: { ok: true; result: Content[] } | { ok: false; error: string }) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: nextId++, method: "browser_result", params: { callId, ...outcome } }));
  };

  const connect = () => {
    retry = undefined;
    if (stopped) return;
    const current = info();
    if (!current) {
      retry = setTimeout(connect, RETRY_MS);
      return;
    }
    const ws = new WebSocket(current.url);
    socket = ws;
    leased = leaseFeed(onLeases);
    let registerId = 0;
    ws.onopen = () => {
      ws.send(JSON.stringify({ auth: current.token }));
      registerId = nextId++;
      ws.send(JSON.stringify({ id: registerId, method: "browser_host_register", params: {} }));
    };
    ws.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      let parsed: { id?: number; ok?: boolean; result?: unknown; event?: string; payload?: unknown };
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (parsed.id === registerId && parsed.ok) return leased(parsed.result);
      if (parsed.event === "browser-leases") return leased(parsed.payload);
      if (parsed.event !== "browser-call") return;
      const call = parsed.payload as BrowserCall;
      tools.run(call).then(
        (result) => answer(ws, call.callId, { ok: true, result }),
        (error: unknown) => answer(ws, call.callId, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket === ws) socket = null;
      // crewd restarted, or is restarting: main's recovery hands out the new address.
      if (!stopped && retry === undefined) retry = setTimeout(connect, RETRY_MS);
    };
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}
