import { beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  return import("./terminalFocus");
}

const handle = () => ({ find: vi.fn() });

beforeEach(() => {
  vi.resetModules();
});

describe("terminal focus", () => {
  it("has no active terminal until one is held", async () => {
    const { activeTerminal } = await load();
    expect(activeTerminal()).toBeNull();
  });

  it("aims at the terminal held last", async () => {
    const { activeTerminal, holdTerminal } = await load();
    const first = handle();
    const second = handle();
    holdTerminal(first);
    holdTerminal(second);
    expect(activeTerminal()).toBe(second);
  });

  it("lets go when the holder releases", async () => {
    const { activeTerminal, holdTerminal } = await load();
    const term = handle();
    const release = holdTerminal(term);
    release();
    expect(activeTerminal()).toBeNull();
  });

  it("keeps the newer terminal when an older holder releases late", async () => {
    const { activeTerminal, holdTerminal } = await load();
    const releaseOld = holdTerminal(handle());
    const current = handle();
    holdTerminal(current);
    releaseOld();
    expect(activeTerminal()).toBe(current);
  });
});
