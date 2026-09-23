import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../../test/fakeSocket";

const INFO = { url: "ws://127.0.0.1:4100", token: "secret" };
const KiB = 1024;
const daemonInfo = vi.fn<() => Promise<typeof INFO>>();

beforeEach(() => {
  vi.resetModules();
  FakeSocket.instances = [];
  daemonInfo.mockReset().mockResolvedValue(INFO);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", {
    crewHost: { daemonInfo },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function load() {
  return (await import("./transport")).transport;
}

/** Lets the daemon_info lookup and the connect chain behind it run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function dialed(): Promise<FakeSocket> {
  await settle();
  return FakeSocket.latest();
}

async function opened(): Promise<FakeSocket> {
  const socket = await dialed();
  socket.open();
  await settle();
  return socket;
}

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function frames(socket: FakeSocket) {
  return socket.sentBinary.map((frame) => ({
    id: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true),
    text: decode(frame.subarray(4)),
  }));
}

function collect() {
  const chunks: string[] = [];
  return { chunks, onBytes: (bytes: Uint8Array) => chunks.push(decode(bytes)) };
}

/** A chunk of `size` bytes, all `mark`, and a sink that records what it got as `mark:size`. */
const chunk = (mark: number, size: number) => new Uint8Array(size).fill(mark);
function collectSizes() {
  const chunks: string[] = [];
  return { chunks, onBytes: (bytes: Uint8Array) => chunks.push(`${bytes[0]}:${bytes.byteLength}`) };
}

describe("requests", () => {
  it("authenticates first, then sends each request with its own id", async () => {
    const transport = await load();
    void transport.request("workspace_list");
    void transport.request("session_get", { id: "s1" });
    const socket = await opened();
    expect(socket.url).toBe(INFO.url);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.sentJson()).toEqual([
      { auth: "secret" },
      { id: 1, method: "workspace_list", params: {} },
      { id: 2, method: "session_get", params: { id: "s1" } },
    ]);
  });

  it("matches each reply to its request by id, even out of order", async () => {
    const transport = await load();
    const first = transport.request("a");
    const second = transport.request("b");
    const socket = await opened();
    socket.message({ id: 2, ok: true, result: "B" });
    socket.message({ id: 1, ok: true, result: "A" });
    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });

  it("rejects with the daemon's error, or a generic one when it gives none", async () => {
    const transport = await load();
    const named = transport.request("a");
    const bare = transport.request("b");
    const socket = await opened();
    socket.message({ id: 1, ok: false, error: "no such session" });
    socket.message({ id: 2, ok: false });
    await expect(named).rejects.toThrow("no such session");
    await expect(bare).rejects.toThrow("Request failed");
  });

  it("ignores replies nobody waits for and frames it can't read", async () => {
    const transport = await load();
    const pending = transport.request("a");
    const socket = await opened();
    socket.message({ id: 99, ok: true, result: "stray" });
    socket.message({ hello: "there" });
    socket.message({ event: "", payload: 1 });
    socket.message("not json");
    socket.message("null");
    socket.message("42");
    socket.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    socket.message({ id: 1, ok: true, result: "real" });
    await expect(pending).resolves.toBe("real");
  });

  it("answers a reply only once", async () => {
    const transport = await load();
    const pending = transport.request("a");
    const socket = await opened();
    socket.message({ id: 1, ok: true, result: "first" });
    socket.message({ id: 1, ok: false, error: "second" });
    await expect(pending).resolves.toBe("first");
  });

  it("refuses a request while the socket is closing", async () => {
    const transport = await load();
    void transport.request("a");
    const socket = await opened();
    socket.readyState = FakeSocket.CLOSING;
    await expect(transport.request("b")).rejects.toThrow("Crew daemon is not connected");
    expect(socket.sentJson().map((frame) => frame.method)).toEqual([undefined, "a"]);
  });
});

describe("connecting", () => {
  it("asks daemon_info again on the next request after it fails", async () => {
    daemonInfo.mockRejectedValueOnce(new Error("not ready"));
    const transport = await load();
    await expect(transport.request("a")).rejects.toThrow("not ready");
    expect(FakeSocket.instances).toHaveLength(0);

    const retry = transport.request<string>("a");
    const socket = await opened();
    socket.message({ id: 1, ok: true, result: "ok" });
    await expect(retry).resolves.toBe("ok");
    expect(daemonInfo).toHaveBeenCalledTimes(2);
  });

  it("rejects when the socket fails to open, and dials again on the next request", async () => {
    const transport = await load();
    const first = transport.request("a");
    (await dialed()).fail();
    await expect(first).rejects.toThrow("Crew daemon connection failed");

    const retry = transport.request("a");
    const socket = await opened();
    expect(FakeSocket.instances).toHaveLength(2);
    socket.message({ id: 1, ok: true, result: "ok" });
    await expect(retry).resolves.toBe("ok");
  });

  it("lets a subscription made before the daemon is up hear events once it connects", async () => {
    daemonInfo.mockRejectedValueOnce(new Error("not ready"));
    const transport = await load();
    const heard = vi.fn();
    transport.on("session-updated", heard);
    await settle();
    expect(FakeSocket.instances).toHaveLength(0);

    void transport.request("a");
    const socket = await opened();
    socket.message({ event: "session-updated", payload: { id: "s1" } });
    expect(heard).toHaveBeenCalledWith({ id: "s1" });
  });
});

describe("events", () => {
  it("fans an event out to every listener until each unsubscribes", async () => {
    const transport = await load();
    const a = vi.fn();
    const b = vi.fn();
    const other = vi.fn();
    const offA = transport.on("pty-exit", a);
    const offB = transport.on("pty-exit", b);
    transport.on("pty-error", other);
    const socket = await opened();

    socket.message({ event: "pty-exit", payload: 1 });
    offA();
    socket.message({ event: "pty-exit", payload: 2 });
    offB();
    socket.message({ event: "pty-exit", payload: 3 });

    expect(a.mock.calls).toEqual([[1]]);
    expect(b.mock.calls).toEqual([[1], [2]]);
    expect(other).not.toHaveBeenCalled();

    const again = vi.fn();
    transport.on("pty-exit", again);
    socket.message({ event: "pty-exit", payload: 4 });
    expect(again.mock.calls).toEqual([[4]]);
  });
});

describe("reconnecting", () => {
  it("fails pending requests when the socket drops and redials 250 ms later", async () => {
    vi.useFakeTimers();
    const transport = await load();
    const pending = transport.request("a");
    const socket = await opened();
    socket.drop();
    await expect(pending).rejects.toThrow("Crew daemon disconnected");

    vi.advanceTimersByTime(249);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const next = await opened();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(next.sentJson()).toEqual([{ auth: "secret" }]);
  });

  it("runs reconnect hooks on a re-open, never on the first open", async () => {
    vi.useFakeTimers();
    const transport = await load();
    const hook = vi.fn();
    const off = transport.onReconnect(hook);
    const heard = vi.fn();
    transport.on("session-updated", heard);
    const first = await opened();
    expect(hook).not.toHaveBeenCalled();

    first.drop();
    vi.advanceTimersByTime(250);
    const second = await opened();
    expect(hook).toHaveBeenCalledTimes(1);
    second.message({ event: "session-updated", payload: "after" });
    expect(heard).toHaveBeenCalledWith("after");

    off();
    second.drop();
    vi.advanceTimersByTime(250);
    await opened();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("keeps redialing every 250 ms until the daemon answers", async () => {
    vi.useFakeTimers();
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    daemonInfo.mockRejectedValueOnce(new Error("restarting"));
    socket.drop();

    vi.advanceTimersByTime(250);
    await settle();
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(250);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(daemonInfo).toHaveBeenCalledTimes(3);
  });

  it("schedules one redial when a failed attempt both errors and closes", async () => {
    vi.useFakeTimers();
    const transport = await load();
    transport.on("x", () => {});
    (await opened()).drop();
    vi.advanceTimersByTime(250);
    const attempt = await dialed();
    attempt.fail();
    attempt.drop();
    await settle();

    vi.advanceTimersByTime(250);
    await settle();
    vi.advanceTimersByTime(250);
    await settle();
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("flushes writes made while the socket was down once it is back", async () => {
    vi.useFakeTimers();
    const transport = await load();
    transport.on("x", () => {});
    (await opened()).drop();
    const write = transport.writeStream(9, encode("echo hi\r"));

    vi.advanceTimersByTime(250);
    const socket = await opened();
    await write;
    expect(FakeSocket.instances).toHaveLength(2);
    expect(frames(socket)).toEqual([{ id: 9, text: "echo hi\r" }]);
  });
});

describe("streams", () => {
  it("delivers binary frames to the stream open for their id", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    const three = collect();
    const four = collect();
    transport.openStream(3, three.onBytes);
    transport.openStream(4, four.onBytes);
    socket.frame(3, "ls");
    socket.frame(4, "top");
    socket.frame(3, "\r\n");
    expect(three.chunks).toEqual(["ls", "\r\n"]);
    expect(four.chunks).toEqual(["top"]);
  });

  it("buffers frames that arrive before the stream opens and replays them in order", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    socket.frame(5, "one ");
    socket.frame(5, "two ");
    socket.frame(5, "three");
    const sink = collect();
    transport.openStream(5, sink.onBytes);
    socket.frame(5, " four");
    expect(sink.chunks).toEqual(["one ", "two ", "three", " four"]);
  });

  it("drops the oldest buffered chunks once a stream holds more than 256 KiB", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    socket.frame(5, chunk(1, 100 * KiB));
    socket.frame(5, chunk(2, 100 * KiB));
    socket.frame(5, chunk(3, 56 * KiB));
    socket.frame(5, chunk(4, 1));
    const sink = collectSizes();
    transport.openStream(5, sink.onBytes);
    expect(sink.chunks).toEqual([`2:${100 * KiB}`, `3:${56 * KiB}`, "4:1"]);
  });

  it("drops a chunk bigger than the whole buffer without losing what is buffered", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    socket.frame(5, chunk(1, 100 * KiB));
    socket.frame(5, chunk(2, 256 * KiB + 1));
    socket.frame(5, chunk(3, 150 * KiB));
    const sink = collectSizes();
    transport.openStream(5, sink.onBytes);
    expect(sink.chunks).toEqual([`1:${100 * KiB}`, `3:${150 * KiB}`]);
  });

  it("ignores frames for a stream after it closes, until it is opened again", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    const before = collect();
    const close = transport.openStream(6, before.onBytes);
    socket.frame(6, "kept");
    close();
    socket.frame(6, "late");
    const after = collect();
    transport.openStream(6, after.onBytes);
    socket.frame(6, "fresh");
    expect(before.chunks).toEqual(["kept"]);
    expect(after.chunks).toEqual(["fresh"]);
  });

  it("keeps a reopened stream when the old handle closes late", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    const before = collect();
    const after = collect();
    const closeOld = transport.openStream(6, before.onBytes);
    transport.openStream(6, after.onBytes);
    closeOld();
    socket.frame(6, "still here");
    expect(before.chunks).toEqual([]);
    expect(after.chunks).toEqual(["still here"]);
  });

  it("remembers only the last 1024 closed stream ids", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    for (let id = 1; id <= 1025; id++) transport.openStream(id, () => {})();
    socket.frame(1, "forgotten");
    socket.frame(2, "remembered");
    const first = collect();
    const second = collect();
    transport.openStream(1, first.onBytes);
    transport.openStream(2, second.onBytes);
    expect(first.chunks).toEqual(["forgotten"]);
    expect(second.chunks).toEqual([]);
  });
});

describe("writes", () => {
  it("frames a write with its stream id and sends it straight away when open", async () => {
    const transport = await load();
    transport.on("x", () => {});
    const socket = await opened();
    await transport.writeStream(0x01020304, encode("q"));
    expect(frames(socket)).toEqual([{ id: 0x01020304, text: "q" }]);
    expect([...(socket.sentBinary[0] ?? [])].slice(0, 4)).toEqual([4, 3, 2, 1]);
  });

  it("holds writes until the socket opens, then sends them after auth in order", async () => {
    const transport = await load();
    let flushed = false;
    const first = transport.writeStream(3, encode("ls\r")).then(() => {
      flushed = true;
    });
    const second = transport.writeStream(4, encode("pwd\r"));
    const socket = await dialed();
    const send = vi.spyOn(socket, "send");
    await settle();
    expect(flushed).toBe(false);

    socket.open();
    await Promise.all([first, second]);
    expect(send.mock.calls.map(([data]) => (typeof data === "string" ? data : "frame"))).toEqual([
      JSON.stringify({ auth: "secret" }),
      "frame",
      "frame",
    ]);
    expect(frames(socket)).toEqual([
      { id: 3, text: "ls\r" },
      { id: 4, text: "pwd\r" },
    ]);
  });

  it("rejects writes past 256 waiting for the socket", async () => {
    const transport = await load();
    const queued = Array.from({ length: 256 }, (_, i) => transport.writeStream(1, encode(String(i))));
    await expect(transport.writeStream(1, encode("over"))).rejects.toThrow("Crew daemon is not connected");

    const socket = await opened();
    await Promise.all(queued);
    expect(frames(socket).map((frame) => frame.text)).toEqual(Array.from({ length: 256 }, (_, i) => String(i)));
  });
});
