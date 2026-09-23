import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "../test/fakeClient";

vi.mock("./client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

let pty: typeof import("./pty");

// The mock keeps what its factory returned across resetModules, so bind it to
// this file's fake before the first reset.
beforeAll(async () => {
  await import("./client");
});

beforeEach(async () => {
  fake.reset();
  vi.resetModules();
  pty = await import("./pty");
});

/** Lets answered requests and the work chained on them land. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function terminal() {
  const data: string[] = [];
  return {
    data,
    onData: (bytes: Uint8Array) => data.push(decode(bytes)),
    onExit: vi.fn<(code: number | null) => void>(),
    onAttach: vi.fn<(start: number) => void>(),
  };
}

/** Spawns `id` on stream `streamId`, answering the attach with `start`. */
async function spawn(id: string, streamId: number, start = 0) {
  fake.respond("pty_spawn", () => streamId);
  fake.respond("pty_attach", () => ({ start, emitted: start }));
  return pty.spawnPty(id, "/repo", ["zsh", "-l"], 80, 24);
}

describe("spawning", () => {
  it("spawns, wires the stream, then attaches from the start", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    await expect(spawn("s1", 7)).resolves.toBe(7);

    expect(fake.sent("pty_spawn")).toEqual([{ id: "s1", cwd: "/repo", command: ["zsh", "-l"], cols: 80, rows: 24 }]);
    expect(fake.sent("pty_attach")).toEqual([{ id: "s1", from: 0 }]);
    expect(term.onAttach).toHaveBeenCalledWith(0);
    fake.push(7, encode("$ "));
    expect(term.data).toEqual(["$ "]);
  });

  it("opens the stream before asking for the replay", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit);
    fake.respond("pty_spawn", () => 7);
    const spawning = pty.spawnPty("s1", "/repo", ["zsh"], 80, 24);
    await settle();
    expect(fake.sent("pty_attach")).toHaveLength(1);
    expect(fake.streamOpen(7)).toBe(true);
    fake.take("pty_attach").resolve({ start: 0, emitted: 0 });
    await expect(spawning).resolves.toBe(7);
  });

  it("still resolves the stream id when the replay attach fails", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    fake.respond("pty_spawn", () => 7);
    fake.respond("pty_attach", () => {
      throw new Error("gone");
    });
    await expect(pty.spawnPty("s1", "/repo", ["zsh"], 80, 24)).resolves.toBe(7);
    expect(term.onAttach).not.toHaveBeenCalled();
    fake.push(7, encode("still here"));
    expect(term.data).toEqual(["still here"]);
  });

  it("fails when the daemon refuses the spawn", async () => {
    fake.respond("pty_spawn", () => {
      throw new Error("no such shell");
    });
    await expect(pty.spawnPty("s1", "/repo", ["nope"], 80, 24)).rejects.toThrow("no such shell");
    expect(fake.sent("pty_attach")).toEqual([]);
  });

  it("keeps the stream of a spawn nobody watches and wires it once someone subscribes", async () => {
    await spawn("s1", 7);
    expect(fake.streamOpen(7)).toBe(false);
    await pty.writePty("s1", "ls\r");
    expect(fake.writes.map((w) => [w.id, decode(w.bytes)])).toEqual([[7, "ls\r"]]);

    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit);
    fake.push(7, encode("a.txt"));
    expect(term.data).toEqual(["a.txt"]);
  });
});

describe("writing", () => {
  it("writes as a request until the stream is wired, then over the stream", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit);
    fake.respond("pty_write", () => undefined);
    await pty.writePty("s1", "early");
    await spawn("s1", 7);
    await pty.writePty("s1", "late");

    expect(fake.sent("pty_write")).toEqual([{ id: "s1", data: "early" }]);
    expect(fake.writes.map((w) => [w.id, decode(w.bytes)])).toEqual([[7, "late"]]);
  });

  it("resizes and acknowledges through requests", async () => {
    fake.respond("pty_resize", () => undefined);
    fake.respond("pty_ack", () => undefined);
    await pty.resizePty("s1", 120, 40);
    await pty.ackPty("s1", 4096);
    expect(fake.sent("pty_resize")).toEqual([{ id: "s1", cols: 120, rows: 40 }]);
    expect(fake.sent("pty_ack")).toEqual([{ id: "s1", processed: 4096 }]);
  });
});

describe("events", () => {
  it("reports only its own session's exit and error", () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit);
    fake.emit("pty-exit", { id: "s2", code: 0 });
    fake.emit("pty-error", { id: "s2", error: "boom" });
    fake.emit("pty-exit", { id: "s1", code: 3 });
    fake.emit("pty-error", { id: "s1", error: "boom" });
    expect(term.onExit.mock.calls).toEqual([[3], [null]]);
  });

  it("stops listening, closes the stream and falls back to requests once unsubscribed", async () => {
    const term = terminal();
    const stop = pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    await spawn("s1", 7);
    stop();

    expect(fake.listening("pty-exit")).toBe(0);
    expect(fake.listening("pty-error")).toBe(0);
    expect(fake.streamOpen(7)).toBe(false);
    fake.respond("pty_write", () => undefined);
    await pty.writePty("s1", "x");
    expect(fake.sent("pty_write")).toEqual([{ id: "s1", data: "x" }]);
    fake.reconnect();
    expect(fake.sent("pty_attach")).toHaveLength(1);
  });

  it("hands the stream to a second subscriber for the same session", async () => {
    const first = terminal();
    const second = terminal();
    pty.subscribePty("s1", first.onData, first.onExit);
    await spawn("s1", 7);
    pty.subscribePty("s1", second.onData, second.onExit);
    fake.push(7, encode("hi"));
    expect(first.data).toEqual([]);
    expect(second.data).toEqual(["hi"]);
  });

  it("leaves the second subscriber's stream open when the first unsubscribes", async () => {
    const first = terminal();
    const second = terminal();
    const stopFirst = pty.subscribePty("s1", first.onData, first.onExit);
    await spawn("s1", 7);
    pty.subscribePty("s1", second.onData, second.onExit);
    stopFirst();
    fake.push(7, encode("hi"));
    expect(second.data).toEqual(["hi"]);
  });
});

describe("reconnecting", () => {
  it("re-attaches every live session from the bytes it has already shown", async () => {
    const one = terminal();
    const two = terminal();
    pty.subscribePty("s1", one.onData, one.onExit, one.onAttach);
    pty.subscribePty("s2", two.onData, two.onExit);
    await spawn("s1", 7);
    await spawn("s2", 8, 100);
    fake.push(7, encode("hello"));
    fake.push(7, encode("!!!"));
    fake.push(8, encode("abc"));

    fake.respond("pty_attach", ({ from }) => ({ start: Number(from) - 2, emitted: 0 }));
    fake.reconnect();
    await settle();
    expect(one.onAttach).toHaveBeenLastCalledWith(6);
    expect(fake.sent("pty_attach").slice(2)).toEqual([
      { id: "s1", from: 8 },
      { id: "s2", from: 103 },
    ]);

    fake.reconnect();
    await settle();
    expect(fake.sent("pty_attach")).toHaveLength(6);
    expect(fake.sent("pty_attach")[4]).toEqual({ id: "s1", from: 6 });
  });

  it("re-attaches from the start a session whose first attach failed before any output", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    fake.respond("pty_spawn", () => 7);
    fake.respond("pty_attach", () => {
      throw new Error("gone");
    });
    await pty.spawnPty("s1", "/repo", ["zsh"], 80, 24);

    fake.respond("pty_attach", () => ({ start: 0, emitted: 0 }));
    fake.reconnect();
    await settle();
    expect(fake.sent("pty_attach")).toEqual([
      { id: "s1", from: 0 },
      { id: "s1", from: 0 },
    ]);
    expect(term.onAttach).toHaveBeenCalledWith(0);
  });

  it("registers one reconnect hook however many terminals subscribe", () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit);
    pty.subscribePty("s2", term.onData, term.onExit);
    expect(fake.client.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores a failed re-attach", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    await spawn("s1", 7);
    fake.respond("pty_attach", () => {
      throw new Error("daemon restarting");
    });
    fake.reconnect();
    await settle();
    expect(fake.sent("pty_attach")).toHaveLength(2);
    expect(term.onAttach).toHaveBeenCalledTimes(1);
  });
});

describe("killing", () => {
  it("closes the stream, forgets the session and asks the daemon to kill it", async () => {
    const term = terminal();
    pty.subscribePty("s1", term.onData, term.onExit, term.onAttach);
    await spawn("s1", 7);
    fake.respond("pty_kill", () => undefined);
    await pty.killPty("s1");

    expect(fake.sent("pty_kill")).toEqual([{ id: "s1" }]);
    expect(fake.streamOpen(7)).toBe(false);
    fake.reconnect();
    expect(fake.sent("pty_attach")).toHaveLength(1);
  });
});
