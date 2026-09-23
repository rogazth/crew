import { afterEach, describe, expect, it, vi } from "vitest";

async function load(): Promise<string> {
  vi.resetModules();
  return (await import("./build-info")).sha;
}

describe("sha", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the commit that the bundler defined", async () => {
    vi.stubGlobal("__CREW_SHA__", "fa723b8");
    expect(await load()).toBe("fa723b8");
  });

  it("falls back to unknown when the build defined nothing", async () => {
    expect(await load()).toBe("unknown");
  });

  it("falls back to unknown when the define is not a string", async () => {
    vi.stubGlobal("__CREW_SHA__", 42);
    expect(await load()).toBe("unknown");
  });
});
