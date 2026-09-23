// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { AgentThemeProvider, useAgentTheme } from "./useAgentTheme";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const provider = (children: ReactNode) => createElement(AgentThemeProvider, null, children);

describe("useAgentTheme", () => {
  beforeEach(() => {
    fake.reset();
    delete document.documentElement.dataset.agentTheme;
  });

  it("reads the default theme and ignores updates outside a provider", () => {
    const hook = renderHook(() => useAgentTheme());
    expect(hook.result.current.theme).toBe("default");
    act(() => hook.result.current.update("timeline"));
    expect(hook.result.current.theme).toBe("default");
    expect(fake.sent("state_set")).toEqual([]);
    hook.unmount();
  });

  it("starts on the default theme and asks the store for the saved one", () => {
    const hook = renderHook(() => useAgentTheme(), provider);
    expect(hook.result.current.theme).toBe("default");
    expect(document.documentElement.dataset.agentTheme).toBe("default");
    expect(fake.sent("state_get")).toEqual([{ key: "agent:theme" }]);
    hook.unmount();
  });

  it("switches to the saved theme and exposes it on the root", async () => {
    const hook = renderHook(() => useAgentTheme(), provider);
    await act(async () => fake.take("state_get").resolve("timeline"));
    expect(hook.result.current.theme).toBe("timeline");
    expect(document.documentElement.dataset.agentTheme).toBe("timeline");
    hook.unmount();
  });

  it.each([
    ["an unknown theme", "neon"],
    ["a missing key", null],
  ])("falls back to the default for %s", async (_, stored) => {
    const hook = renderHook(() => useAgentTheme(), provider);
    await act(async () => fake.take("state_get").resolve(stored));
    expect(hook.result.current.theme).toBe("default");
    hook.unmount();
  });

  it("keeps the default when the store fails", async () => {
    const hook = renderHook(() => useAgentTheme(), provider);
    await act(async () => fake.take("state_get").reject(new Error("offline")));
    expect(hook.result.current.theme).toBe("default");
    hook.unmount();
  });

  it("drops a saved theme that lands after unmount", async () => {
    const hook = renderHook(() => useAgentTheme(), provider);
    const request = fake.take("state_get");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => request.resolve("timeline"));
    expect(hook.renders()).toBe(renders);
    expect(document.documentElement.dataset.agentTheme).toBe("default");
  });

  it("applies an update at once and saves it", async () => {
    const hook = renderHook(() => useAgentTheme(), provider);
    await act(async () => fake.take("state_get").resolve("default"));
    act(() => hook.result.current.update("timeline"));
    expect(hook.result.current.theme).toBe("timeline");
    expect(document.documentElement.dataset.agentTheme).toBe("timeline");
    expect(fake.sent("state_set")).toEqual([{ key: "agent:theme", value: "timeline" }]);
    hook.unmount();
  });

  it("keeps an update when saving it fails", async () => {
    fake.respond("state_set", () => {
      throw new Error("read-only");
    });
    const hook = renderHook(() => useAgentTheme(), provider);
    await act(async () => hook.result.current.update("timeline"));
    expect(hook.result.current.theme).toBe("timeline");
    hook.unmount();
  });
});
