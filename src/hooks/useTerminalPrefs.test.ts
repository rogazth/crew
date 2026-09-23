// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from "../lib/terminalPrefs";
import { deferred } from "../test/deferred";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { TerminalPrefsProvider, useTerminalPrefs } from "./useTerminalPrefs";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const provider = (children: ReactNode) => createElement(TerminalPrefsProvider, null, children);

const custom: TerminalPrefs = {
  fontSize: 16,
  fontFamily: "JetBrains Mono",
  fontWeight: 400,
  fontWeightBold: 800,
  lineHeight: 1.2,
  ligatures: "on",
};

describe("useTerminalPrefs", () => {
  beforeEach(() => fake.reset());

  it("reads the defaults and ignores updates outside a provider", () => {
    const hook = renderHook(() => useTerminalPrefs());
    expect(hook.result.current.prefs).toEqual(DEFAULT_TERMINAL_PREFS);
    act(() => hook.result.current.update(custom));
    expect(hook.result.current.prefs).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(fake.sent("state_set")).toEqual([]);
    hook.unmount();
  });

  it("serves the defaults until the saved prefs arrive", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    expect(hook.result.current.prefs).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(fake.sent("state_get")).toEqual([{ key: "terminal:prefs" }]);
    await act(async () => fake.take("state_get").resolve(JSON.stringify(custom)));
    expect(hook.result.current.prefs).toEqual(custom);
    hook.unmount();
  });

  it("clamps saved sizes and weights into their limits", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    const stored = { ...custom, fontSize: 99, fontWeight: 5, fontWeightBold: 2000, lineHeight: 0.2 };
    await act(async () => fake.take("state_get").resolve(JSON.stringify(stored)));
    expect(hook.result.current.prefs).toMatchObject({
      fontSize: 32,
      fontWeight: 100,
      fontWeightBold: 900,
      lineHeight: 1,
    });
    hook.unmount();
  });

  it("fills a partial or wrongly typed record from the defaults", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    const stored = { fontSize: "big", fontFamily: "  ", ligatures: "maybe", lineHeight: 2 };
    await act(async () => fake.take("state_get").resolve(JSON.stringify(stored)));
    expect(hook.result.current.prefs).toEqual({ ...DEFAULT_TERMINAL_PREFS, lineHeight: 2 });
    hook.unmount();
  });

  it.each([
    ["corrupt JSON", "{font"],
    ["a missing key", null],
  ])("keeps the defaults for %s", async (_, stored) => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    await act(async () => fake.take("state_get").resolve(stored));
    expect(hook.result.current.prefs).toEqual(DEFAULT_TERMINAL_PREFS);
    hook.unmount();
  });

  it("keeps the defaults when the store fails", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    await act(async () => fake.take("state_get").reject(new Error("offline")));
    expect(hook.result.current.prefs).toEqual(DEFAULT_TERMINAL_PREFS);
    hook.unmount();
  });

  it("drops saved prefs that land after unmount", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    const request = fake.take("state_get");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => request.resolve(JSON.stringify(custom)));
    expect(hook.renders()).toBe(renders);
  });

  it("applies an update at once and saves it as JSON", async () => {
    const hook = renderHook(() => useTerminalPrefs(), provider);
    await act(async () => fake.take("state_get").resolve(null));
    act(() => hook.result.current.update(custom));
    expect(hook.result.current.prefs).toEqual(custom);
    expect(fake.sent("state_set")).toEqual([{ key: "terminal:prefs", value: JSON.stringify(custom) }]);
    hook.unmount();
  });

  it("keeps and saves prefs changed before the saved ones load", async () => {
    const saved = deferred<string | null>();
    fake.respond("state_get", () => saved.promise);
    const hook = renderHook(() => useTerminalPrefs(), provider);
    act(() => hook.result.current.update(custom));
    await act(async () => saved.resolve(JSON.stringify({ ...custom, fontSize: 20 })));
    expect(hook.result.current.prefs).toEqual(custom);
    expect(fake.sent("state_set")).toEqual([{ key: "terminal:prefs", value: JSON.stringify(custom) }]);
    hook.unmount();
  });

  it("keeps an update when saving it fails", async () => {
    fake.respond("state_set", () => {
      throw new Error("read-only");
    });
    const hook = renderHook(() => useTerminalPrefs(), provider);
    await act(async () => hook.result.current.update(custom));
    expect(hook.result.current.prefs).toEqual(custom);
    hook.unmount();
  });
});
