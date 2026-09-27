import type { Event, Hello, Response } from "../protocol";

type Listener = (event: string, payload: unknown) => void;
type Endpoint = { url: string; token: string };

const CLOSED_CAP = 1024;
const BUFFER_MAX_BYTES = 256 * 1024;
const WRITE_CAP = 256;
const PING_EVERY_MS = 5_000;
const PING_TIMEOUT_MS = 15_000;
/** From `new WebSocket` to the daemon's hello. A tailnet peer that is off never answers the SYN. */
const OPEN_TIMEOUT_MS = 8_000;
const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 10_000;

/**
 * `connecting` is the first attempt, a manual reconnect, or the retry right
 * after a live socket dropped. Once an attempt fails the link is `offline`,
 * and the retries behind it do not flip it back until one succeeds.
 */
export type ConnStatus = "connecting" | "online" | "offline";

/**
 * One WebSocket to one daemon. The window's daemon and each remote are one of
 * these; stream ids are only unique inside a single connection.
 */
export class Connection {
  status: ConnStatus = "connecting";
  latency: number | null = null;
  protocol: number | null = null;
  version: string | null = null;
  /** Why the last attempt failed, in words for Settings. Cleared once online. */
  error: string | null = null;
  /** Set when this daemon speaks a protocol the local one does not. */
  mismatch = false;
  onChange: (() => void) | null = null;
  onEvent: Listener | null = null;
  /** Fired when a socket that had already been up comes back, not on the first open. */
  onReconnect: (() => void) | null = null;
  onHello: ((hello: Hello) => void) | null = null;

  /** Has been online at least once since the window opened. */
  ever = false;

  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private stopped = false;
  private delay = BACKOFF_MIN_MS;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly streams = new Map<number, (bytes: Uint8Array) => void>();
  private readonly buffered = new Map<number, Uint8Array[]>();
  private readonly bufferedBytes = new Map<number, number>();
  private readonly closed = new Set<number>();
  private readonly closedOrder: number[] = [];
  private readonly writes: Array<{ id: number; bytes: Uint8Array; resolve: () => void }> = [];

  /**
   * `failFast`: a request made while the link is offline rejects at once with
   * `EnvDown` instead of waiting on an attempt. Remotes set it; the window's
   * own daemon waits, since the app brings that one back.
   */
  constructor(
    readonly envId: string,
    private readonly endpoint: () => Promise<Endpoint>,
    private readonly failFast = false,
  ) {}

  get ready(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.status === "online";
  }

  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new EnvDown(this.envId));
    if (!this.opened) {
      this.clearRetry();
      this.opened = this.open().catch((error: unknown) => {
        this.opened = null;
        this.fail(error instanceof Error ? error.message : String(error));
        this.schedule();
        throw error instanceof Error ? error : new Error(String(error));
      });
    }
    return this.opened;
  }

  /** Drop the socket and open again now, instead of waiting out the backoff. */
  wake(): void {
    if (this.stopped) return;
    this.delay = BACKOFF_MIN_MS;
    this.clearRetry();
    this.setStatus("connecting");
    if (this.socket) this.socket.close();
    else if (!this.opened) void this.connect().catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    this.clearRetry();
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    this.opened = null;
    socket?.close();
    this.failPending(new EnvDown(this.envId));
  }

  request<T>(method: string, params: object = {}): Promise<T> {
    if (this.mismatch) return Promise.reject(new Error("This machine runs a crewd the app cannot talk to. Update it in Settings › Environments."));
    if (this.failFast && this.status === "offline" && !this.opened) {
      this.kick();
      return Promise.reject(new EnvDown(this.envId));
    }
    return this.connect().then(() => {
      const ws = this.socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new EnvDown(this.envId);
      const id = this.nextId++;
      return new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    });
  }

  openStream(id: number, onBytes: (bytes: Uint8Array) => void): () => void {
    this.closed.delete(id);
    this.streams.set(id, onBytes);
    const queue = this.buffered.get(id);
    if (queue) {
      this.buffered.delete(id);
      this.bufferedBytes.delete(id);
      for (const chunk of queue) onBytes(chunk);
    }
    return () => {
      if (this.streams.get(id) === onBytes) this.streams.delete(id);
      this.buffered.delete(id);
      this.bufferedBytes.delete(id);
      this.markClosed(id);
    };
  }

  writeStream(id: number, bytes: Uint8Array): Promise<void> {
    const ws = this.socket;
    if (ws && this.ready) {
      this.sendFrame(ws, id, bytes);
      return Promise.resolve();
    }
    if (this.writes.length >= WRITE_CAP) return Promise.reject(new EnvDown(this.envId));
    return new Promise((resolve) => {
      this.writes.push({ id, bytes, resolve });
      void this.connect().catch(() => {});
    });
  }

  /**
   * Resolves on the daemon's hello, not on the socket's open: a token the
   * daemon refuses closes the socket before it, and that is a failure.
   */
  private async open(): Promise<void> {
    const endpoint = await this.endpoint();
    if (this.stopped) throw new EnvDown(this.envId);
    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(endpoint.url);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      ws.binaryType = "arraybuffer";
      let authed = false;
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = globalThis.setTimeout(() => {
        settle(new Error(`No answer from ${hostOf(endpoint.url)}`));
        ws.close();
      }, OPEN_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(JSON.stringify({ auth: endpoint.token }));
      };
      ws.onerror = () => settle(new Error(`Could not reach ${hostOf(endpoint.url)}`));
      ws.onmessage = (event) => {
        if (!authed && typeof event.data === "string" && isHello(event.data)) {
          authed = true;
          this.adopt(ws);
          settle();
        }
        if (this.socket === ws) this.onMessage(event);
      };
      ws.onclose = () => {
        if (!authed) {
          settle(new Error(settled ? "Connection closed" : "The machine refused the token"));
          return;
        }
        if (this.socket !== ws) return;
        this.socket = null;
        this.opened = null;
        this.clearPing();
        this.failPending(new EnvDown(this.envId));
        if (this.stopped) return;
        // A live link that drops gets one quick try before it reads as offline.
        this.delay = BACKOFF_MIN_MS;
        this.setStatus("connecting");
        this.schedule();
      };
    });
  }

  private adopt(ws: WebSocket) {
    const again = this.ever;
    this.socket = ws;
    this.ever = true;
    this.delay = BACKOFF_MIN_MS;
    this.error = null;
    this.setStatus("online");
    this.flushWrites();
    this.armPing();
    if (again) this.onReconnect?.();
  }

  private fail(reason: string) {
    this.error = reason;
    this.latency = null;
    if (this.status === "offline") this.onChange?.();
    else this.setStatus("offline");
  }

  private schedule() {
    if (this.stopped || this.retry !== null) return;
    const wait = this.delay;
    this.delay = Math.min(Math.max(this.delay, BACKOFF_MIN_MS) * 2, BACKOFF_MAX_MS);
    this.retry = globalThis.setTimeout(() => {
      this.retry = null;
      if (this.stopped || this.socket || this.opened) return;
      void this.connect().catch(() => {});
    }, wait);
  }

  /** A request found the link down: try again soon, without waiting out a long backoff. */
  private kick() {
    if (this.retry === null || this.delay <= 2_000) return;
    this.clearRetry();
    this.delay = 1_000;
    this.schedule();
  }

  private clearRetry() {
    if (this.retry !== null) globalThis.clearTimeout(this.retry);
    this.retry = null;
  }

  private setStatus(next: ConnStatus) {
    if (this.status === next) return;
    this.status = next;
    if (next !== "online") this.latency = null;
    this.onChange?.();
  }

  private failPending(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes.byteLength < 4) return;
      const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      const payload = bytes.subarray(4);
      if (this.closed.has(id)) return;
      const handler = this.streams.get(id);
      if (handler) {
        handler(payload);
        return;
      }
      const queue = this.buffered.get(id) ?? [];
      let size = this.bufferedBytes.get(id) ?? 0;
      while (queue.length > 0 && size + payload.byteLength > BUFFER_MAX_BYTES) {
        const old = queue.shift();
        if (!old) break;
        size -= old.byteLength;
      }
      if (size + payload.byteLength > BUFFER_MAX_BYTES) return;
      queue.push(payload);
      this.buffered.set(id, queue);
      this.bufferedBytes.set(id, size + payload.byteLength);
      return;
    }

    const message = JSON.parse(event.data) as Response | Event;
    if ("event" in message && message.event) {
      if (message.event === "hello") {
        const hello = message.payload as Hello;
        this.protocol = hello.protocol;
        this.version = hello.version;
        this.onHello?.(hello);
        this.onChange?.();
      }
      this.onEvent?.(message.event, message.payload);
      return;
    }
    if (!("id" in message)) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? "Request failed"));
  }

  private markClosed(id: number) {
    if (this.closed.has(id)) return;
    this.closed.add(id);
    this.closedOrder.push(id);
    if (this.closedOrder.length > CLOSED_CAP) {
      const old = this.closedOrder.shift();
      if (old !== undefined) this.closed.delete(old);
    }
  }

  private sendFrame(ws: WebSocket, id: number, bytes: Uint8Array) {
    const frame = new Uint8Array(4 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(bytes, 4);
    ws.send(frame);
  }

  private flushWrites() {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (this.writes.length) {
      const item = this.writes.shift();
      if (!item) break;
      this.sendFrame(ws, item.id, item.bytes);
      item.resolve();
    }
  }

  private armPing() {
    this.clearPing();
    // The browser cannot send a WebSocket ping frame. An RPC round trip is the
    // same signal, and its duration is the latency the UI shows.
    if (typeof window === "undefined") return;
    this.beat();
    this.ping = globalThis.setInterval(() => this.beat(), PING_EVERY_MS);
  }

  private beat() {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.mismatch || this.pingTimer !== null) return;
    const started = performance.now();
    const timer = globalThis.setTimeout(() => {
      this.pingTimer = null;
      if (this.socket === ws) ws.close();
    }, PING_TIMEOUT_MS);
    this.pingTimer = timer;
    void this.request("ping", {})
      .then(() => {
        const latency = Math.round(performance.now() - started);
        if (latency !== this.latency) {
          this.latency = latency;
          this.onChange?.();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.pingTimer === timer) {
          globalThis.clearTimeout(timer);
          this.pingTimer = null;
        }
      });
  }

  private clearPing() {
    if (this.ping !== null) globalThis.clearInterval(this.ping);
    this.ping = null;
    if (this.pingTimer !== null) globalThis.clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }
}

/** A remote that is down, distinct from a request the daemon refused. */
export class EnvDown extends Error {
  constructor(readonly envId: string) {
    super("That machine is offline");
    this.name = "EnvDown";
  }
}

function isHello(data: string): boolean {
  try {
    return (JSON.parse(data) as { event?: unknown }).event === "hello";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
