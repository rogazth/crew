import { beforeEach, describe, expect, it, vi } from "vitest";

const daemon = vi.hoisted(() => ({
  client: { request: vi.fn(), on: vi.fn(() => () => {}), onReconnect: vi.fn(() => () => {}) },
}));

vi.mock("./client", () => ({ client: daemon.client }));

import { isRunning, markRunning, markStopped, sessionOfPty } from "./runningSessions";

describe("sessionOfPty", () => {
  it("reads the session and its workspace off a terminal's id", () => {
    expect(sessionOfPty("ws1/session:abc")).toEqual({ session: "abc", workspace: "ws1" });
    expect(sessionOfPty("ws1@/repo/wt/session:abc")).toEqual({ session: "abc", workspace: "ws1" });
  });

  it("is nothing for a shell's terminal", () => {
    expect(sessionOfPty("ws1/stub:terminal:42")).toBeNull();
  });
});

describe("running sessions", () => {
  beforeEach(() => markStopped("a"));

  it("holds what started until it is stopped", () => {
    markRunning("a", "ws1");
    expect(isRunning("a")).toBe(true);
    markStopped("a");
    expect(isRunning("a")).toBe(false);
  });
});
