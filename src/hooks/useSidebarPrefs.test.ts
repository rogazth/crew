// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, type SidebarPrefs } from "../lib/sidebarPrefs";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useSidebarPrefs } from "./useSidebarPrefs";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const custom: SidebarPrefs = {
  grouping: "provider",
  ordering: "name",
  show: ["status"],
  hiddenKinds: ["terminal"],
  hiddenProviders: ["codex"],
};

describe("useSidebarPrefs", () => {
  beforeEach(() => fake.reset());

  it("stays null until the store answers", () => {
    const hook = renderHook(() => useSidebarPrefs());
    expect(hook.result.current[0]).toBeNull();
    expect(fake.sent("state_get")).toEqual([{ key: "sidebar:prefs" }]);
    hook.unmount();
  });

  it("serves the saved prefs", async () => {
    const hook = renderHook(() => useSidebarPrefs());
    await act(async () => fake.take("state_get").resolve(JSON.stringify(custom)));
    expect(hook.result.current[0]).toEqual(custom);
    hook.unmount();
  });

  it("repairs each field of a record with the wrong shape", async () => {
    const hook = renderHook(() => useSidebarPrefs());
    const stored = {
      grouping: "color",
      ordering: 3,
      show: ["status", "mood"],
      hiddenKinds: ["agent", "browser"],
      hiddenProviders: ["claude", 7],
    };
    await act(async () => fake.take("state_get").resolve(JSON.stringify(stored)));
    expect(hook.result.current[0]).toEqual({
      grouping: "kind",
      ordering: "updated",
      show: ["status"],
      hiddenKinds: ["agent"],
      hiddenProviders: ["claude"],
    });
    hook.unmount();
  });

  it.each([
    ["corrupt JSON", "{grouping"],
    ["a missing key", null],
  ])("falls back to the defaults for %s", async (_, stored) => {
    const hook = renderHook(() => useSidebarPrefs());
    await act(async () => fake.take("state_get").resolve(stored));
    expect(hook.result.current[0]).toEqual(DEFAULT_PREFS);
    hook.unmount();
  });

  it("falls back to the defaults when the store fails", async () => {
    const hook = renderHook(() => useSidebarPrefs());
    await act(async () => fake.take("state_get").reject(new Error("offline")));
    expect(hook.result.current[0]).toEqual(DEFAULT_PREFS);
    hook.unmount();
  });

  it.each([
    ["an answer", (request: ReturnType<typeof fake.take>) => request.resolve(JSON.stringify(custom))],
    ["a failure", (request: ReturnType<typeof fake.take>) => request.reject(new Error("offline"))],
  ])("drops %s that lands after unmount", async (_, settle) => {
    const hook = renderHook(() => useSidebarPrefs());
    const request = fake.take("state_get");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => settle(request));
    expect(hook.renders()).toBe(renders);
    expect(hook.result.current[0]).toBeNull();
  });

  it("applies an update at once and saves it as JSON", async () => {
    const hook = renderHook(() => useSidebarPrefs());
    await act(async () => fake.take("state_get").resolve(null));
    const [, update] = hook.result.current;
    act(() => update(custom));
    expect(hook.result.current[0]).toEqual(custom);
    expect(hook.result.current[1]).toBe(update);
    expect(fake.sent("state_set")).toEqual([{ key: "sidebar:prefs", value: JSON.stringify(custom) }]);
    hook.unmount();
  });

  it("keeps an update when saving it fails", async () => {
    fake.respond("state_set", () => {
      throw new Error("read-only");
    });
    const hook = renderHook(() => useSidebarPrefs());
    await act(async () => hook.result.current[1](custom));
    expect(hook.result.current[0]).toEqual(custom);
    hook.unmount();
  });
});
