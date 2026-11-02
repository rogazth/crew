import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, EnvDown } from "./connection";
import { trace } from "../trace";

vi.mock("../trace", async (original) => ({
  ...(await original<typeof import("../trace")>()),
  trace: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() },
}));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((event?: { code: number; wasClean: boolean }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sent.push(data);
  }

  close(code?: number) {
    this.readyState = 3;
    this.onclose?.(code === undefined ? undefined : { code, wasClean: false });
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
  describe("trace", () => {
    const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown>]>;

    beforeEach(() => {
      for (const level of ["info", "warn", "error"] as const) vi.mocked(trace[level]).mockClear();
    });

    it("records the socket opening, closing with its code, and the retry that follows, per machine", async () => {
      const conn = new Connection("vps", endpoint, true);
      const opened = conn.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      latest().open();
      latest().hello();
      await opened;
      expect(calls(trace.info).map(([message]) => message)).toEqual(["socket.connect", "socket.open"]);
      expect(calls(trace.info)[1]?.[1]).toMatchObject({ machine: "vps", attempt: 1 });
      latest().close(1006);
      expect(calls(trace.warn)[0]).toEqual([
        "socket.closed",
        expect.objectContaining({ machine: "vps", code: 1006, clean: false, retry: true }),
      ]);
      expect(calls(trace.info).map(([message]) => message)).toContain("socket.retry");
      conn.stop();
    });

    it("records a refused token, and a request the daemon refused by method and error, never its params", async () => {
      const conn = new Connection("vps", endpoint, true);
      const opened = conn.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      latest().open();
      latest().close(1008);
      await expect(opened).rejects.toThrow();
      expect(calls(trace.warn).map(([message]) => message)).toContain("socket.refused");
      conn.stop();

      const live = new Connection("vps", endpoint, true);
      const up = live.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
      latest().open();
      latest().hello();
      await up;
      const failing = live.request("pty_write", { id: "t1", data: "secret keystrokes" });
      await vi.waitFor(() => expect(latest().sent.length).toBeGreaterThan(1));
      const sent = JSON.parse(latest().sent.at(-1) as string) as { id: number };
      latest().onmessage?.({ data: JSON.stringify({ id: sent.id, ok: false, error: "Terminal is not running" }) });
      await expect(failing).rejects.toThrow("Terminal is not running");
      const failed = calls(trace.warn).find(([message]) => message === "request.failed");
      expect(failed?.[1]).toEqual({ machine: "vps", method: "pty_write", error: "Terminal is not running" });
      expect(JSON.stringify(calls(trace.warn))).not.toContain("secret keystrokes");
      live.stop();
    });

    it("records an endpoint that could not be had, a socket that errored and one that never answered, each with the attempt", async () => {
      const lost = new Connection("vps", () => Promise.reject(new Error("tailscale is not running")), true);
      await expect(lost.connect()).rejects.toThrow("tailscale is not running");
      expect(calls(trace.warn)).toContainEqual(["socket.no_endpoint", { machine: "vps", attempt: 1, error: "tailscale is not running" }]);
      lost.stop();

      const errored = new Connection("vps", endpoint, true);
      const failed = errored.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      latest().onerror?.();
      await expect(failed).rejects.toThrow("Could not reach");
      // The host and port it tried, never the URL or the token.
      expect(calls(trace.warn)).toContainEqual(["socket.error", { machine: "vps", attempt: 1, host: "100.64.0.2:17877" }]);
      errored.stop();

      const silent = new Connection("vps", endpoint, true);
      const waiting = silent.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
      vi.advanceTimersByTime(8_000);
      await expect(waiting).rejects.toThrow("No answer from");
      expect(calls(trace.warn)).toContainEqual(["socket.timeout", { machine: "vps", attempt: 1, waited_ms: 8_000 }]);
      silent.stop();
      expect(JSON.stringify(calls(trace.warn))).not.toContain("tok");
    });

    it("says once that a request met a machine that is down, however many follow", async () => {
      const conn = new Connection("vps", endpoint, true);
      const opened = conn.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      latest().onerror?.();
      await expect(opened).rejects.toThrow("Could not reach");
      await expect(conn.request("pty_write", { id: "t1", data: "secret keystrokes" })).rejects.toBeInstanceOf(EnvDown);
      await expect(conn.request("session_list", {})).rejects.toBeInstanceOf(EnvDown);
      const down = calls(trace.warn).filter(([message]) => message === "request.machine_down");
      // The method and the machine, never the params.
      expect(down).toEqual([["request.machine_down", { machine: "vps", method: "pty_write" }]]);
      expect(JSON.stringify(calls(trace.warn))).not.toContain("secret keystrokes");
      conn.stop();
    });

    it("records a heartbeat nobody answered before it closes the socket", async () => {
      // The ping runs only where there is a window.
      vi.stubGlobal("window", {});
      const conn = new Connection("vps", endpoint, true);
      const opened = conn.connect();
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      latest().open();
      latest().hello();
      await opened;
      const socket = latest();
      await vi.waitFor(() => expect(socket.sent.some((frame) => frame.includes('"method":"ping"'))).toBe(true));
      expect(calls(trace.warn).map(([message]) => message)).not.toContain("socket.ping_timeout");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls(trace.warn)).toContainEqual(["socket.ping_timeout", { machine: "vps", waited_ms: 15_000 }]);
      expect(socket.readyState).toBe(3);
      conn.stop();
    });
  });
});
