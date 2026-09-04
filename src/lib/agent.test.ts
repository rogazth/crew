import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const on = vi.fn(() => () => {});
const onReconnect = vi.fn<(hook: () => void) => () => void>(() => () => {});

vi.mock("./client", () => ({
  client: { request, on, onReconnect, openStream: vi.fn(), writeStream: vi.fn() },
}));

describe("recoverExits", () => {
  beforeEach(() => {
    vi.resetModules();
    request.mockReset();
    on.mockReset();
    on.mockReturnValue(() => {});
    onReconnect.mockReset();
  });

  it("fires the exit handler after reconnect when the process died before stdout", async () => {
    let hook = () => {};
    onReconnect.mockImplementation((fn: () => void) => {
      hook = fn;
      return () => {};
    });
    request.mockResolvedValue([]);
    const { watchAgent } = await import("./agent");
    const onExit = vi.fn();
    watchAgent("s1", () => {}, onExit);
    hook();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(null));
  });

  it("does not synthesize an exit for a process that is still running", async () => {
    let hook = () => {};
    onReconnect.mockImplementation((fn: () => void) => {
      hook = fn;
      return () => {};
    });
    request.mockResolvedValue(["s2"]);
    const { watchAgent } = await import("./agent");
    const onExit = vi.fn();
    watchAgent("s2", () => {}, onExit);
    hook();
    await Promise.resolve();
    await Promise.resolve();
    expect(onExit).not.toHaveBeenCalled();
  });
});
