import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, EnvDown } from "./connection";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  hello() {
    this.onmessage?.({ data: JSON.stringify({ event: "hello", payload: { protocol: 1, version: "0.1.0" } }) });
  }
}

const endpoint = () => Promise.resolve({ url: "ws://100.64.0.2:17877", token: "tok" });

function latest(): FakeSocket {
  const socket = FakeSocket.instances.at(-1);
  if (!socket) throw new Error("no socket yet");
  return socket;
}

describe("Connection", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("is online only once the daemon says hello", async () => {
    const conn = new Connection("vps", endpoint, true);
    const opened = conn.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().open();
    expect(conn.status).toBe("connecting");
    expect(latest().sent[0]).toBe(JSON.stringify({ auth: "tok" }));
    latest().hello();
    await opened;
    expect(conn.status).toBe("online");
    expect(conn.version).toBe("0.1.0");
    conn.stop();
  });

  it("says the token was refused when the socket closes before hello", async () => {
    const conn = new Connection("vps", endpoint, true);
    const opened = conn.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().open();
    latest().close();
    await expect(opened).rejects.toThrow("refused the token");
    expect(conn.status).toBe("offline");
    expect(conn.error).toContain("refused the token");
    conn.stop();
  });

  it("gives up on a host that never answers, and keeps trying behind it", async () => {
    const conn = new Connection("vps", endpoint, true);
    const opened = conn.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    vi.advanceTimersByTime(8_000);
    await expect(opened).rejects.toThrow("No answer from 100.64.0.2:17877");
    expect(conn.status).toBe("offline");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    latest().open();
    latest().hello();
    await vi.waitFor(() => expect(conn.status).toBe("online"));
    expect(conn.error).toBeNull();
    conn.stop();
  });

  it("fails a request at once while the machine is offline", async () => {
    const conn = new Connection("vps", endpoint, true);
    const opened = conn.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().onerror?.();
    await expect(opened).rejects.toThrow("Could not reach");
    await expect(conn.request("session_list", {})).rejects.toBeInstanceOf(EnvDown);
    conn.stop();
  });

  it("drops to connecting when a live socket closes, and reconnects", async () => {
    const conn = new Connection("vps", endpoint, true);
    const back = vi.fn();
    conn.onReconnect = back;
    const opened = conn.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    latest().open();
    latest().hello();
    await opened;

    const pending = conn.request("session_list", {});
    latest().close();
    await expect(pending).rejects.toBeInstanceOf(EnvDown);
    expect(conn.status).toBe("connecting");

    await vi.advanceTimersByTimeAsync(300);
    latest().open();
    latest().hello();
    await vi.waitFor(() => expect(conn.status).toBe("online"));
    expect(back).toHaveBeenCalledTimes(1);
    conn.stop();
  });
});
