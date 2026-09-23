/**
 * A `WebSocket` the test drives by hand. Install with
 * `vi.stubGlobal("WebSocket", FakeSocket)` and reset `FakeSocket.instances`
 * in `beforeEach`.
 */
export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  static latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error("no socket was opened");
    return socket;
  }

  readyState = FakeSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  /** Text frames sent, in order. */
  sent: string[] = [];
  /** Binary frames sent, in order. */
  sentBinary: Uint8Array[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBufferView | ArrayBuffer) {
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof ArrayBuffer) this.sentBinary.push(new Uint8Array(data));
    else this.sentBinary.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  /** Text frames sent, parsed as JSON. */
  sentJson<T = Record<string, unknown>>(): T[] {
    return this.sent.map((text) => JSON.parse(text) as T);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  /** A binary frame as the daemon sends it: a little-endian u32 stream id, then the bytes. */
  frame(id: number, bytes: Uint8Array | string) {
    const payload = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const frame = new Uint8Array(4 + payload.byteLength);
    new DataView(frame.buffer).setUint32(0, id, true);
    frame.set(payload, 4);
    this.onmessage?.({ data: frame.buffer });
  }
}
