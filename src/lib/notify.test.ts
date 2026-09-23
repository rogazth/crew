import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "./notify";

function host(notifyImpl: (title: string, body: string) => Promise<void>) {
  const crewHost = { notify: vi.fn(notifyImpl) };
  vi.stubGlobal("window", { crewHost });
  return crewHost;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notify", () => {
  it("shows a native banner through the host", async () => {
    const crewHost = host(() => Promise.resolve());
    await notify("Agent finished", "All tests pass.");
    expect(crewHost.notify).toHaveBeenCalledWith("Agent finished", "All tests pass.");
  });

  it("cuts the body to 200 characters", async () => {
    const crewHost = host(() => Promise.resolve());
    await notify("Done", "x".repeat(500));
    expect(crewHost.notify).toHaveBeenCalledWith("Done", "x".repeat(200));
  });

  it("stays quiet when the banner fails", async () => {
    const crewHost = host(() => Promise.reject(new Error("notifications denied")));
    await expect(notify("Done", "body")).resolves.toBeUndefined();
    expect(crewHost.notify).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the host throws before it can promise anything", async () => {
    host(() => {
      throw new Error("no host");
    });
    await expect(notify("Done", "body")).resolves.toBeUndefined();
  });
});
