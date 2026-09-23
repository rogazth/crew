// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../lib/providers";

// Hoisted so every fresh module graph below talks to this one fake.
const { fake } = await vi.hoisted(() => import("../test/fakeClient"));
vi.mock("../lib/client", () => ({ client: fake.client }));

/** A fresh module per test: the choice and the one-time load live at module level. */
async function load() {
  vi.resetModules();
  const [{ act, renderHook }, { useDefaultAgent }] = await Promise.all([
    import("../test/renderHook"),
    import("./useDefaultAgent"),
  ]);
  fake.reset();
  return { act, renderHook, useDefaultAgent };
}

const claude = { provider: "claude", model: "" };

describe("useDefaultAgent", () => {
  it("starts on Claude with the CLI's own model and every provider offered", async () => {
    const { renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    expect(hook.result.current.preferred).toEqual(claude);
    expect(hook.result.current.effective).toEqual(claude);
    expect(hook.result.current.installed.map((p) => p.id)).toEqual(PROVIDERS.map((p) => p.id));
    expect(fake.sent("state_get")).toEqual([{ key: "providers:default" }]);
    hook.unmount();
  });

  it("adopts the stored choice", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    const stored = JSON.stringify({ provider: "codex", model: "gpt-5" });
    await act(async () => fake.take("state_get").resolve(stored));
    expect(hook.result.current.preferred).toEqual({ provider: "codex", model: "gpt-5" });
    expect(hook.result.current.effective).toEqual({ provider: "codex", model: "gpt-5" });
    hook.unmount();
  });

  it.each([
    ["a missing key", null],
    ["corrupt JSON", "{provider"],
    ["an unknown provider", JSON.stringify({ provider: "emacs", model: "" })],
    ["a value of the wrong shape", JSON.stringify(["codex"])],
  ])("keeps the default for %s", async (_, stored) => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    await act(async () => fake.take("state_get").resolve(stored));
    expect(hook.result.current.preferred).toEqual(claude);
    hook.unmount();
  });

  it("keeps the default when the store fails", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    await act(async () => fake.take("state_get").reject(new Error("offline")));
    expect(hook.result.current.preferred).toEqual(claude);
    hook.unmount();
  });

  it("loads the stored choice once for every mount", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const first = renderHook(() => useDefaultAgent());
    const second = renderHook(() => useDefaultAgent());
    expect(fake.sent("state_get")).toHaveLength(1);
    await act(async () => fake.take("state_get").resolve(JSON.stringify({ provider: "opencode" })));
    expect(first.result.current.preferred).toEqual({ provider: "opencode", model: "" });
    expect(second.result.current.preferred).toEqual({ provider: "opencode", model: "" });
    first.unmount();
    second.unmount();

    const third = renderHook(() => useDefaultAgent());
    expect(third.result.current.preferred).toEqual({ provider: "opencode", model: "" });
    expect(fake.sent("state_get")).toHaveLength(1);
    third.unmount();
  });

  it("publishes an update to every mount and saves it", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const first = renderHook(() => useDefaultAgent());
    const second = renderHook(() => useDefaultAgent());
    const next = { provider: "cursor", model: "sonnet-4" } as const;
    act(() => first.result.current.update(next));
    expect(first.result.current.preferred).toEqual(next);
    expect(second.result.current.preferred).toEqual(next);
    expect(fake.sent("state_set")).toEqual([{ key: "providers:default", value: JSON.stringify(next) }]);
    first.unmount();
    second.unmount();
  });

  it("stops publishing to a mount once it unmounts", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const gone = renderHook(() => useDefaultAgent());
    const kept = renderHook(() => useDefaultAgent());
    gone.unmount();
    const renders = gone.renders();
    act(() => kept.result.current.update({ provider: "codex", model: "" }));
    expect(gone.renders()).toBe(renders);
    expect(kept.result.current.preferred).toEqual({ provider: "codex", model: "" });
    kept.unmount();
  });

  it("keeps an update when saving it fails", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    fake.respond("state_set", () => {
      throw new Error("read-only");
    });
    const hook = renderHook(() => useDefaultAgent());
    await act(async () => hook.result.current.update({ provider: "codex", model: "" }));
    expect(hook.result.current.preferred).toEqual({ provider: "codex", model: "" });
    hook.unmount();
  });

  it("starts with the first installed provider when the preferred CLI is missing", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    const stored = JSON.stringify({ provider: "claude", model: "opus" });
    await act(async () => fake.take("state_get").resolve(stored));
    await act(async () => fake.take("agent_installed").resolve(["opencode", "codex"]));
    expect(hook.result.current.preferred).toEqual({ provider: "claude", model: "opus" });
    expect(hook.result.current.effective).toEqual({ provider: "codex", model: "" });
    expect(hook.result.current.installed.map((p) => p.id)).toEqual(["codex", "opencode"]);
    hook.unmount();
  });

  it("keeps the preferred choice when no CLI is installed", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook(() => useDefaultAgent());
    await act(async () => fake.take("agent_installed").resolve([]));
    expect(hook.result.current.installed).toEqual([]);
    expect(hook.result.current.effective).toEqual(claude);
    hook.unmount();
  });

  it("looks for installed CLIs again when refresh changes", async () => {
    const { act, renderHook, useDefaultAgent } = await load();
    const hook = renderHook((refresh: number) => useDefaultAgent(refresh), 1);
    await act(async () => fake.take("agent_installed").resolve(["codex"]));
    expect(hook.result.current.effective).toEqual({ provider: "codex", model: "" });
    hook.rerender(2);
    await act(async () => fake.take("agent_installed").resolve(["claude", "codex"]));
    expect(hook.result.current.effective).toEqual(claude);
    expect(fake.sent("state_get")).toHaveLength(1);
    hook.unmount();
  });
});
