/**
 * A browser WebSocket client for a real `crewd`.
 *
 * The app's own transport reaches the daemon through Electron's preload bridge.
 * A prototype has no preload, so it asks the dev server instead: the Vite plugin
 * in `design/tools/vite-crewd.ts` starts (or finds) a daemon and serves its url
 * and token at `/__crew/daemon`.
 *
 * Request/response and events are the daemon's own JSON protocol. Binary frames
 * are PTY traffic — a 4-byte little-endian stream id followed by bytes — and are
 * routed the same way the app routes them.
 */
export type DaemonInfo = { url: string; token: string };

export type TransportOptions = {
  /** Where to ask for `{url, token}`. */
  discover?: () => Promise<DaemonInfo>;
  /** Called on every connection state change. */
  onState?: (state: ConnectionState) => void;
};

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "open" }
  | { status: "closed"; error?: string };

const DEFAULT_DISCOVERY = "/__crew/daemon";

export async function discoverDaemon(): Promise<DaemonInfo> {
  const response = await fetch(DEFAULT_DISCOVERY, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `No daemon behind ${DEFAULT_DISCOVERY} (${response.status}). Is the crewd Vite plugin enabled?`,
    );
  }
  const info = (await response.json()) as Partial<DaemonInfo> & { error?: string };
  if (info.error) throw new Error(info.error);
  if (typeof info.url !== "string" || typeof info.token !== "string") {
    throw new Error("Daemon discovery returned no url/token");
  }
  return { url: info.url, token: info.token };
}

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export class Transport {
  private socket: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private readonly pending = new Map<number, Waiter>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly streams = new Map<number, (bytes: Uint8Array) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private nextId = 1;
  private reconnectTimer: number | null = null;
  private retries = 0;
  private disposed = false;
  private state: ConnectionState = { status: "idle" };

  constructor(private readonly options: TransportOptions = {}) {
    if (options.onState) this.stateListeners.add(options.onState);
  }

  get connection(): ConnectionState {
    return this.state;
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState) {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Transport disposed"));
    if (!this.opening) {
      this.opening = this.open().catch((error: unknown) => {
        this.opening = null;
        throw error;
      });
    }
    return this.opening;
  }

  private async open(): Promise<void> {
    this.setState({ status: "connecting" });
    const discover = this.options.discover ?? discoverDaemon;
    const info = await discover();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(info.url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.socket = ws;
        this.retries = 0;
        ws.send(JSON.stringify({ auth: info.token }));
        this.setState({ status: "open" });
        resolve();
      };
      ws.onerror = () => reject(new Error(`Cannot reach the daemon at ${info.url}`));
      ws.onmessage = (event) => this.onMessage(event);
      ws.onclose = () => {
        this.socket = null;
        this.opening = null;
        this.failPending(new Error("Daemon disconnected"));
        this.setState({ status: "closed" });
        this.scheduleReconnect();
      };
    });
  }

  private failPending(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  /** Backs off to a second so a daemon that is down does not spin the tab. */
  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(1_000, 100 * 2 ** this.retries);
    this.retries += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private onMessage(event: MessageEvent) {
    if (typeof event.data !== "string") {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes.byteLength < 4) return;
      const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      this.streams.get(id)?.(bytes.subarray(4));
      return;
    }
    const message = JSON.parse(event.data) as
      | { event: string; payload: unknown }
      | { id: number; ok: boolean; result?: unknown; error?: string };
    if ("event" in message) {
      for (const listener of this.listeners.get(message.event) ?? []) listener(message.payload);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? "Request failed"));
  }

  async request<T>(method: string, params: object = {}): Promise<T> {
    await this.connect();
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Daemon is not connected");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    void this.connect().catch(() => {});
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  openStream(id: number, onBytes: (bytes: Uint8Array) => void): () => void {
    this.streams.set(id, onBytes);
    return () => {
      if (this.streams.get(id) === onBytes) this.streams.delete(id);
    };
  }

  writeStream(id: number, bytes: Uint8Array) {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(4 + bytes.byteLength);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(bytes, 4);
    ws.send(frame);
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.failPending(new Error("Transport disposed"));
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
    this.streams.clear();
    this.stateListeners.clear();
  }
}
