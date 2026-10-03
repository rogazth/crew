import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ client: { on: vi.fn(), request: vi.fn() } }));
vi.mock("./notifications", () => ({ dispatchNotification: vi.fn() }));

const { crashNews } = await import("./processAlerts");

const run = (state: "running" | "exited" | "crashed" | "stopped" | "starting", exitCode: number | null = null) => ({
  state,
  exitCode,
});

describe("crashNews", () => {
  it("is news when a command fails on its own", () => {
    expect(crashNews("running", run("exited", 1))).toBe("Exited with code 1");
    expect(crashNews("running", run("exited", null))).toBe("Was killed by a signal");
    expect(crashNews("starting", run("crashed"))).toBe("Kept crashing, and was left stopped");
  });

  it("is not news for a clean exit, a stop, or a state already known", () => {
    expect(crashNews("running", run("exited", 0))).toBeNull();
    expect(crashNews("running", run("stopped"))).toBeNull();
    expect(crashNews("exited", run("exited", 1))).toBeNull();
    expect(crashNews(undefined, run("crashed"))).toBeNull();
  });
});
