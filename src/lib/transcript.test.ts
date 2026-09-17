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

function page(blocks: Block[], seq: number, options: { from?: number; more?: boolean; working?: boolean } = {}) {
  const from = options.from ?? 1;
  return {
    blocks,
    fromPos: blocks.length > 0 ? from : 0,
    toPos: blocks.length > 0 ? from + blocks.length - 1 : 0,
    more: options.more ?? false,
    working: options.working ?? false,
    status: options.working ? "working" : "idle",
    seq,
  };
}

const said = (text: string): Block => ({ id: text, role: "assistant", text });

/** requestAnimationFrame, run by hand, so a test can say when a frame happened. */
let frames: Array<() => void> = [];

async function load(id: string) {
  const transcript = await import("./transcript");
  await transcript.load(id);
  return transcript;
}

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

describe("transcript", () => {
  it("opens a thread from the daemon and publishes it once", async () => {
    request.mockResolvedValue(page([said("hello")], 4));
    const transcript = await load("s1");
    expect(transcript.read("s1").blocks).toHaveLength(1);
    expect(transcript.isReady("s1")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not ask twice for a thread it already has", async () => {
    request.mockResolvedValue(page([], 0));
    const transcript = await load("s1");
    await transcript.load("s1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps what it had when the daemon refuses", async () => {
    request.mockResolvedValue(page([said("kept")], 1));
    const transcript = await load("s1");
    request.mockRejectedValueOnce(new Error("gone"));
    await transcript.reload("s1");
    expect(transcript.read("s1").blocks[0]?.text).toBe("kept");
  });

  it("applies the next event in sequence", async () => {
    request.mockResolvedValue(page([], 7));
    const transcript = await load("s1");
    remote()({ sessionId: "s1", seq: 8, event: { type: "message.delta", text: "hi" } });
    paint();
    expect(transcript.read("s1").blocks.at(-1)?.text).toBe("hi");
  });

  it("resyncs instead of guessing when an event is missing", async () => {
    request.mockResolvedValue(page([], 7));
    const transcript = await load("s1");
    request.mockResolvedValue(page([said("caught up")], 12));

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
    request.mockResolvedValue(page([], 0));
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
    request.mockResolvedValue(page([], 0));
    const transcript = await load("s1");
    const before = transcript.read("s1");
    transcript.apply("s1", { type: "message.delta", text: "x" });
    paint();
    expect(transcript.read("s1")).not.toBe(before);
  });

  it("forgets a thread and stops painting it", async () => {
    request.mockResolvedValue(page([said("old")], 1));
    const transcript = await load("s1");
    transcript.apply("s1", { type: "message.delta", text: "pending" });
    transcript.forget("s1");
    paint();
    expect(transcript.read("s1").blocks).toHaveLength(0);
    expect(transcript.isReady("s1")).toBe(false);
  });

  it("reloads every open thread when the socket comes back", async () => {
    request.mockResolvedValue(page([], 1));
    await load("s1");
    const reconnect = onReconnect.mock.calls[0]?.[0] as () => void;
    request.mockClear();
    reconnect();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });
});

describe("the window", () => {
  it("opens on the last page and says there is more behind it", async () => {
    request.mockResolvedValue(page([said("recent")], 3, { from: 41, more: true }));
    const transcript = await load("s1");
    expect(transcript.read("s1").more).toBe(true);
    expect(request).toHaveBeenCalledWith("transcript_tail", { sessionId: "s1", limit: 200 });
  });

  it("prepends the page before the one it holds", async () => {
    request.mockResolvedValue(page([said("recent")], 3, { from: 41, more: true }));
    const transcript = await load("s1");
    request.mockResolvedValue(page([said("older")], 3, { from: 21, more: true }));

    await transcript.loadEarlier("s1");
    expect(request).toHaveBeenLastCalledWith("transcript_tail", {
      sessionId: "s1",
      limit: 200,
      beforePos: 41,
    });
    expect(transcript.read("s1").blocks.map((block) => block.text)).toEqual(["older", "recent"]);
  });

  it("stops offering earlier messages once the first page is in", async () => {
    request.mockResolvedValue(page([said("recent")], 3, { from: 11, more: true }));
    const transcript = await load("s1");
    request.mockResolvedValue(page([said("first")], 3, { from: 1, more: false }));
    await transcript.loadEarlier("s1");
    expect(transcript.read("s1").more).toBe(false);
  });

  it("does not ask twice while a page is in flight", async () => {
    request.mockResolvedValue(page([said("recent")], 3, { from: 41, more: true }));
    const transcript = await load("s1");
    request.mockReset();
    request.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(page([said("older")], 3, { from: 21 })), 10)),
    );
    const first = transcript.loadEarlier("s1");
    await transcript.loadEarlier("s1");
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing older when there is nothing older", async () => {
    request.mockResolvedValue(page([said("all of it")], 1));
    const transcript = await load("s1");
    request.mockClear();
    await transcript.loadEarlier("s1");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the history a reader already opened when it resyncs", async () => {
    request.mockResolvedValue(page([said("a"), said("b")], 5, { from: 41, more: true }));
    const transcript = await load("s1");
    request.mockResolvedValue(page([said("older"), said("a"), said("b")], 5, { from: 21, more: true }));
    await transcript.loadEarlier("s1");

    request.mockClear();
    request.mockResolvedValue(page([said("older"), said("a"), said("b")], 9, { from: 21, more: true }));
    await transcript.reload("s1");
    // Three blocks in hand, so the resync must not shrink the window to one page.
    expect(request).toHaveBeenCalledWith("transcript_tail", { sessionId: "s1", limit: 200 });
    expect(transcript.read("s1").blocks).toHaveLength(3);
  });
});

describe("focus", () => {
  it("takes the reader to a block already in the window", async () => {
    request.mockResolvedValue(page([said("a"), said("b"), said("c")], 2, { from: 10 }));
    const transcript = await load("s1");
    await transcript.focus("s1", 11);
    expect(transcript.read("s1").focusId).toBe("b");
  });

  it("walks history back until the hit is in hand", async () => {
    request.mockResolvedValue(page([said("recent")], 2, { from: 21, more: true }));
    const transcript = await load("s1");
    request.mockResolvedValue(page([said("wanted")], 2, { from: 20, more: true }));
    await transcript.focus("s1", 20);
    expect(transcript.read("s1").focusId).toBe("wanted");
  });

  it("gives up rather than walking a year of pages", async () => {
    request.mockResolvedValue(page([said("recent")], 2, { from: 5000, more: true }));
    const transcript = await load("s1");
    request.mockClear();
    request.mockImplementation(() =>
      Promise.resolve(page([said("older")], 2, { from: 4999, more: true })),
    );
    await transcript.focus("s1", 1);
    // Five pages, then it stops and leaves them where it got to.
    expect(request).toHaveBeenCalledTimes(5);
    expect(transcript.read("s1").focusId).toBeNull();
  });

  it("forgets the mark once the chat has shown it", async () => {
    request.mockResolvedValue(page([said("a")], 2, { from: 1 }));
    const transcript = await load("s1");
    await transcript.focus("s1", 1);
    expect(transcript.read("s1").focusId).toBe("a");
    transcript.clearFocus("s1");
    expect(transcript.read("s1").focusId).toBeNull();
  });
});
