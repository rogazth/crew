import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "./protocol";

const request = vi.fn();
const on = vi.fn();
const onReconnect = vi.fn();
vi.mock("./client", () => ({ client: { request, on, onReconnect } }));

/** The one the bridge registered for "transcript-apply". */
function remote(): (payload: unknown) => void {
  const hook = on.mock.calls.find(([event]) => event === "transcript-apply");
  if (!hook) throw new Error("the bridge never subscribed");
  return hook[1] as (payload: unknown) => void;
}

function snapshot(blocks: Block[], seq: number, working = false) {
  return { blocks, working, status: working ? "working" : "idle", seq };
}

const said = (text: string): Block => ({ id: text, role: "assistant", text });

/** requestAnimationFrame, run by hand, so a test can say when a frame happened. */
let frames: Array<() => void> = [];

async function load(id: string) {
  const transcript = await import("./transcript");
  await transcript.load(id);
  return transcript;
}

describe("transcript", () => {
  beforeEach(() => {
    vi.resetModules();
    request.mockReset();
    on.mockReset();
    onReconnect.mockReset();
    frames = [];
    // The store paints through window, and vitest runs this file in node.
    vi.stubGlobal("window", {
      requestAnimationFrame: (fn: () => void) => {
        frames.push(fn);
        return frames.length;
      },
      cancelAnimationFrame: (handle: number) => {
        frames[handle - 1] = () => undefined;
      },
    });
  });

  function paint() {
    const queued = frames;
    frames = [];
    for (const frame of queued) frame();
  }

  it("opens a thread from the daemon and publishes it once", async () => {
    request.mockResolvedValue(snapshot([said("hello")], 4));
    const transcript = await load("s1");
    expect(transcript.read("s1").blocks).toHaveLength(1);
    expect(transcript.isReady("s1")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not ask twice for a thread it already has", async () => {
    request.mockResolvedValue(snapshot([], 0));
    const transcript = await load("s1");
    await transcript.load("s1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps what it had when the daemon refuses", async () => {
    request.mockResolvedValue(snapshot([said("kept")], 1));
    const transcript = await load("s1");
    request.mockRejectedValueOnce(new Error("gone"));
    await transcript.reload("s1");
    expect(transcript.read("s1").blocks[0]?.text).toBe("kept");
  });

  it("applies the next event in sequence", async () => {
    request.mockResolvedValue(snapshot([], 7));
    const transcript = await load("s1");
    remote()({ sessionId: "s1", seq: 8, event: { type: "message.delta", text: "hi" } });
    paint();
    expect(transcript.read("s1").blocks.at(-1)?.text).toBe("hi");
  });

  it("resyncs instead of guessing when an event is missing", async () => {
    request.mockResolvedValue(snapshot([], 7));
    const transcript = await load("s1");
    request.mockResolvedValue(snapshot([said("caught up")], 12));

    // seq 10 with 7 in hand: something was lost on the way.
    remote()({ sessionId: "s1", seq: 10, event: { type: "message.delta", text: "dropped" } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(transcript.read("s1").blocks.at(-1)?.text).toBe("caught up");
  });

  it("ignores events for a thread nobody opened", async () => {
    await import("./transcript");
    const transcript = await import("./transcript");
    transcript.subscribe("s9", () => undefined);
    remote()({ sessionId: "s9", seq: 1, event: { type: "message.delta", text: "noise" } });
    paint();
    expect(transcript.read("s9").blocks).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("paints once for a burst of deltas", async () => {
    request.mockResolvedValue(snapshot([], 0));
    const transcript = await load("s1");
    let paints = 0;
    transcript.subscribe("s1", () => (paints += 1));
    for (const text of ["a", "b", "c"]) {
      transcript.apply("s1", { type: "message.delta", text });
    }
    expect(paints).toBe(0);
    paint();
    expect(paints).toBe(1);
    expect(transcript.read("s1").blocks.at(-1)?.text).toBe("abc");
  });

  it("hands out a new snapshot object per paint, so React sees the change", async () => {
    request.mockResolvedValue(snapshot([], 0));
    const transcript = await load("s1");
    const before = transcript.read("s1");
    transcript.apply("s1", { type: "message.delta", text: "x" });
    paint();
    expect(transcript.read("s1")).not.toBe(before);
  });

  it("forgets a thread and stops painting it", async () => {
    request.mockResolvedValue(snapshot([said("old")], 1));
    const transcript = await load("s1");
    transcript.apply("s1", { type: "message.delta", text: "pending" });
    transcript.forget("s1");
    paint();
    expect(transcript.read("s1").blocks).toHaveLength(0);
    expect(transcript.isReady("s1")).toBe(false);
  });

  it("reloads every open thread when the socket comes back", async () => {
    request.mockResolvedValue(snapshot([], 1));
    await load("s1");
    const reconnect = onReconnect.mock.calls[0]?.[0] as () => void;
    request.mockClear();
    reconnect();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });
});
