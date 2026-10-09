import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReading } from "./protocol";

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

function heard(sessionId: string, event: unknown) {
  remote()({ sessionId, seq: 1, event });
}

const flush = () => new Promise((done) => setTimeout(done, 0));

async function meter() {
  return import("./contextMeter");
}

beforeEach(() => {
  vi.resetModules();
  request.mockReset();
  on.mockReset();
  onReconnect.mockReset();
});

describe("the reading a new one makes", () => {
  it("replaces the last reading, keeping its window when the new one has none", async () => {
    const { mergeReading } = await meter();
    const last: ContextReading = { used: 10, window: 200_000, autoCompactAt: 180_000 };
    expect(mergeReading(last, { used: 40 })).toEqual({ used: 40, window: 200_000, autoCompactAt: 180_000 });
    expect(mergeReading(last, { used: 40, window: 1_000_000 })).toEqual({ used: 40, window: 1_000_000 });
    expect(mergeReading(undefined, { used: 40 })).toEqual({ used: 40 });
  });
});

describe("a token count", () => {
  it("reads in thousands, and in millions from a million on", async () => {
    const { tokenCount } = await meter();
    expect([41_400, 999_499, 1_000_000, 1_250_000].map(tokenCount)).toEqual(["41k", "999k", "1M", "1.3M"]);
  });
});

describe("the store", () => {
  it("keeps the newest reading heard for a session", async () => {
    const { subscribeContext, readContext } = await meter();
    request.mockResolvedValue(null);
    subscribeContext("s1", () => {});
    heard("s1", { type: "context.updated", used: 10, window: 200_000, autoCompactAt: 180_000 });
    heard("s1", { type: "context.updated", used: 40 });
    expect(readContext("s1")).toEqual({ used: 40, window: 200_000, autoCompactAt: 180_000 });
    expect(readContext("s2")).toBeNull();
  });

  it("leaves the reading alone for any other transcript event", async () => {
    const { subscribeContext, readContext } = await meter();
    request.mockResolvedValue(null);
    subscribeContext("s1", () => {});
    heard("s1", { type: "message.delta", text: "hi" });
    expect(readContext("s1")).toBeNull();
  });

  it("asks the daemon for a session's reading the first time it is watched", async () => {
    const { subscribeContext, readContext } = await meter();
    request.mockResolvedValue({ used: 12, window: 200_000 });
    subscribeContext("s1", () => {});
    expect(request).toHaveBeenCalledWith("session_context", { sessionId: "s1" });
    await flush();
    expect(readContext("s1")).toEqual({ used: 12, window: 200_000 });
  });

  it("does not let a reading asked before an event overwrite that event", async () => {
    const { subscribeContext, readContext } = await meter();
    let answer: (reading: ContextReading) => void = () => {};
    request.mockReturnValue(new Promise<ContextReading>((done) => (answer = done)));
    subscribeContext("s1", () => {});
    heard("s1", { type: "context.updated", used: 40, window: 200_000 });
    answer({ used: 5, window: 200_000 });
    await flush();
    expect(readContext("s1")).toEqual({ used: 40, window: 200_000 });
  });

  it("tells each listener of a session when its reading changes", async () => {
    const { subscribeContext } = await meter();
    request.mockResolvedValue(null);
    const listener = vi.fn();
    const unsubscribe = subscribeContext("s1", listener);
    heard("s1", { type: "context.updated", used: 10 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    heard("s1", { type: "context.updated", used: 20 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
