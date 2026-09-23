// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../lib/providers";

// Hoisted so every fresh module graph below talks to this one fake.
const { fake } = await vi.hoisted(() => import("../test/fakeClient"));
vi.mock("../lib/client", () => ({ client: fake.client }));

const ids = (list: Array<{ id: string }>) => list.map((provider) => provider.id);

/** A fresh module per test: the hook caches the last answer across mounts. */
async function load() {
  vi.resetModules();
  const [{ act, renderHook }, { useInstalledProviders }] = await Promise.all([
    import("../test/renderHook"),
    import("./useInstalledProviders"),
  ]);
  fake.reset();
  return { act, renderHook, useInstalledProviders };
}

describe("useInstalledProviders", () => {
  it("offers every provider until the first answer", async () => {
    const { renderHook, useInstalledProviders } = await load();
    const hook = renderHook(() => useInstalledProviders());
    expect(ids(hook.result.current)).toEqual(ids(PROVIDERS));
    expect(fake.sent("agent_installed")).toEqual([
      { names: ["claude", "cursor-agent", "codex", "opencode"] },
    ]);
    hook.unmount();
  });

  it("narrows to the providers whose CLI was found, in registry order", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const hook = renderHook(() => useInstalledProviders());
    await act(async () => fake.take("agent_installed").resolve(["opencode", "claude", "vim"]));
    expect(ids(hook.result.current)).toEqual(["claude", "opencode"]);
    hook.unmount();
  });

  it("starts later mounts from the last answer", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const first = renderHook(() => useInstalledProviders());
    await act(async () => fake.take("agent_installed").resolve(["codex"]));
    first.unmount();

    const second = renderHook(() => useInstalledProviders());
    expect(ids(second.result.current)).toEqual(["codex"]);
    expect(fake.sent("agent_installed")).toHaveLength(2);
    second.unmount();
  });

  it("asks again only when refresh changes", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const hook = renderHook((refresh: number) => useInstalledProviders(refresh), 1);
    await act(async () => fake.take("agent_installed").resolve(["claude"]));
    hook.rerender(1);
    expect(fake.sent("agent_installed")).toHaveLength(1);

    hook.rerender(2);
    expect(fake.sent("agent_installed")).toHaveLength(2);
    await act(async () => fake.take("agent_installed").resolve(["claude", "codex"]));
    expect(ids(hook.result.current)).toEqual(["claude", "codex"]);
    hook.unmount();
  });

  it("drops an answer that lands after refresh moved on", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const hook = renderHook((refresh: number) => useInstalledProviders(refresh), 1);
    const stale = fake.take("agent_installed");
    hook.rerender(2);
    const fresh = fake.take("agent_installed");

    await act(async () => fresh.resolve(["codex"]));
    await act(async () => stale.resolve(["claude"]));
    expect(ids(hook.result.current)).toEqual(["codex"]);
    hook.unmount();
  });

  it("keeps what it had when the lookup fails, and asks again on the next refresh", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const hook = renderHook((refresh: number) => useInstalledProviders(refresh), 1);
    await act(async () => fake.take("agent_installed").resolve(["cursor-agent"]));
    hook.rerender(2);
    await act(async () => fake.take("agent_installed").reject(new Error("offline")));
    expect(ids(hook.result.current)).toEqual(["cursor"]);

    hook.rerender(3);
    await act(async () => fake.take("agent_installed").resolve(["cursor-agent", "codex"]));
    expect(ids(hook.result.current)).toEqual(["cursor", "codex"]);
    hook.unmount();
  });

  it("does not update after unmount, but remembers the answer", async () => {
    const { act, renderHook, useInstalledProviders } = await load();
    const hook = renderHook(() => useInstalledProviders());
    const request = fake.take("agent_installed");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => request.resolve(["codex"]));
    expect(hook.renders()).toBe(renders);

    const next = renderHook(() => useInstalledProviders());
    expect(ids(next.result.current)).toEqual(["codex"]);
    next.unmount();
  });
});
