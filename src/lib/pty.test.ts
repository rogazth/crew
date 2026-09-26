import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const openStream = vi.fn();

vi.mock("./client", () => ({
  client: {
    request,
    on: () => () => {},
    onReconnect: () => () => {},
    openStream,
    writeStream: vi.fn(),
  },
}));

const pty = await import("./pty");

describe("pty", () => {
  beforeEach(() => {
    request.mockReset();
    openStream.mockReset();
    openStream.mockReturnValue(() => {});
    request.mockImplementation((method: string, params: { from: number }) =>
      Promise.resolve(method === "pty_attach" ? { start: params.from, emitted: params.from } : null),
    );
  });

  it("does not count writes queued before a resync toward the replay", () => {
    const parsed = pty.parsedCount();
    parsed.attached(100);
    const before = parsed.write(40);
    parsed.resync();
    parsed.attached(0);
    // xterm parses what it had queued after the reset, and calls back.
    expect(before()).toBe(false);
    expect(parsed.processed).toBe(0);
    const after = parsed.write(25);
    expect(after()).toBe(true);
    expect(parsed.processed).toBe(25);
  });

  it("attaches a new stream from its first byte and drops what was buffered for it", async () => {
    const off = pty.subscribePty("t", () => {}, () => {});
    await pty.attachPty("t", 1);
    // The first stream delivered some bytes to this view.
    const deliver = openStream.mock.calls[0]?.[1] as (bytes: Uint8Array) => void;
    deliver(new Uint8Array(500));

    // A respawn: a new stream for the same terminal.
    await pty.attachPty("t", 2);
    const [streamId, , replay] = openStream.mock.calls[1] ?? [];
    expect([streamId, replay]).toEqual([2, false]);
    const attaches = request.mock.calls.filter(([method]) => method === "pty_attach").map(([, params]) => params);
    expect(attaches).toEqual([
      { id: "t", from: 0 },
      { id: "t", from: 0 },
    ]);
    off();
  });
});
