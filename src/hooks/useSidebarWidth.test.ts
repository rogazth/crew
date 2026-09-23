// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useSidebarWidth } from "./useSidebarWidth";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

async function loaded(stored: string | null) {
  const hook = renderHook(() => useSidebarWidth());
  await act(async () => fake.take("state_get").resolve(stored));
  return hook;
}

describe("useSidebarWidth", () => {
  beforeEach(() => {
    fake.reset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("renders nothing until the stored width arrives", () => {
    const hook = renderHook(() => useSidebarWidth());
    expect(hook.result.current.width).toBeNull();
    expect(fake.sent("state_get")).toEqual([{ key: "sidebar:width" }]);
    hook.unmount();
  });

  it("opens at the stored width", async () => {
    const hook = await loaded("312");
    expect(hook.result.current.width).toBe(312);
    hook.unmount();
  });

  it.each([
    ["a missing key", null],
    ["a non-number", "wide"],
    ["zero", "0"],
    ["a negative width", "-40"],
    ["an infinite width", "Infinity"],
  ])("opens at the default width for %s", async (_, stored) => {
    const hook = await loaded(stored);
    expect(hook.result.current.width).toBe(264);
    hook.unmount();
  });

  it("opens at the default width when the store fails", async () => {
    const hook = renderHook(() => useSidebarWidth());
    await act(async () => fake.take("state_get").reject(new Error("offline")));
    expect(hook.result.current.width).toBe(264);
    hook.unmount();
  });

  it.each([
    ["an answer", (request: ReturnType<typeof fake.take>) => request.resolve("300")],
    ["a failure", (request: ReturnType<typeof fake.take>) => request.reject(new Error("offline"))],
  ])("drops %s that lands after unmount", async (_, settle) => {
    const hook = renderHook(() => useSidebarWidth());
    const request = fake.take("state_get");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => settle(request));
    expect(hook.renders()).toBe(renders);
    expect(hook.result.current.width).toBeNull();
  });

  it("saves only where a drag stopped, rounded, once it rests", async () => {
    const hook = await loaded("264");
    const { commit } = hook.result.current;
    commit(280.2);
    await vi.advanceTimersByTimeAsync(150);
    commit(301.6);
    await vi.advanceTimersByTimeAsync(199);
    expect(fake.sent("state_set")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent("state_set")).toEqual([{ key: "sidebar:width", value: "302" }]);
    expect(hook.result.current.commit).toBe(commit);
    hook.unmount();
  });

  it("does not move the width it reports while dragging", async () => {
    const hook = await loaded("264");
    act(() => hook.result.current.commit(400));
    await vi.advanceTimersByTimeAsync(200);
    expect(hook.result.current.width).toBe(264);
    hook.unmount();
  });

  it("brings back the committed width on the next mount", async () => {
    const store = new Map<string, string>();
    fake.respond("state_get", ({ key }) => store.get(key as string) ?? null);
    fake.respond("state_set", ({ key, value }) => void store.set(key as string, value as string));

    const first = renderHook(() => useSidebarWidth());
    await act(async () => {});
    expect(first.result.current.width).toBe(264);
    first.result.current.commit(333);
    await vi.advanceTimersByTimeAsync(200);
    first.unmount();

    const second = renderHook(() => useSidebarWidth());
    await act(async () => {});
    expect(second.result.current.width).toBe(333);
    second.unmount();
  });

  it("saves where the drag stopped at once when the sidebar unmounts mid-debounce", async () => {
    const hook = await loaded("264");
    hook.result.current.commit(280);
    hook.result.current.commit(300.4);
    hook.unmount();
    expect(fake.sent("state_set")).toEqual([{ key: "sidebar:width", value: "300" }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.sent("state_set")).toHaveLength(1);
  });

  it("saves nothing more on unmount once the drag has been saved", async () => {
    const hook = await loaded("264");
    hook.result.current.commit(300);
    await vi.advanceTimersByTimeAsync(200);
    hook.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.sent("state_set")).toEqual([{ key: "sidebar:width", value: "300" }]);
  });

  it("swallows a failed save", async () => {
    fake.respond("state_set", () => {
      throw new Error("read-only");
    });
    const hook = await loaded("264");
    hook.result.current.commit(300);
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.sent("state_set")).toEqual([{ key: "sidebar:width", value: "300" }]);
    hook.unmount();
  });
});
