// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "../chrome/AgentSheet";
import { MIN_SAVE_MS } from "../lib/timing";
import type { Session } from "../lib/types";
import { act, renderHook } from "../test/renderHook";
import { useAgentSheet } from "./useAgentSheet";

const draft: AgentDraft = {
  name: "Reviewer",
  provider: "claude",
  model: "",
  description: "reads diffs",
  notifications: true,
  autonomy: "ask",
};

const session = { id: "s1", name: "Reviewer" } as Session;

type Deps = Parameters<typeof useAgentSheet>[0];

function setup(created: Session | null = session) {
  const deps = {
    create: vi.fn<Deps["create"]>(async () => created),
    update: vi.fn<Deps["update"]>(async () => {}),
    openSession: vi.fn<Deps["openSession"]>(),
  };
  const hook = renderHook(() => useAgentSheet(deps));
  return { deps, hook };
}

/** Whether `promise` has settled, checked without waiting on it. */
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  return done;
}

describe("useAgentSheet", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts closed", () => {
    const { hook } = setup();
    expect(hook.result.current.sheet).toBeNull();
    hook.unmount();
  });

  it("opens empty for a new agent, on the session for an edit, and closes", () => {
    const { hook } = setup();
    act(() => hook.result.current.newAgent());
    expect(hook.result.current.sheet).toEqual({ session: null });
    act(() => hook.result.current.editAgent(session));
    expect(hook.result.current.sheet).toEqual({ session });
    act(() => hook.result.current.close());
    expect(hook.result.current.sheet).toBeNull();
    hook.unmount();
  });

  it("keeps its openers stable across renders", () => {
    const { hook } = setup();
    const { newAgent, editAgent, close } = hook.result.current;
    act(() => newAgent());
    expect(hook.result.current.newAgent).toBe(newAgent);
    expect(hook.result.current.editAgent).toBe(editAgent);
    expect(hook.result.current.close).toBe(close);
    hook.unmount();
  });

  it("creates an agent from a new sheet and opens it", async () => {
    const { deps, hook } = setup();
    act(() => hook.result.current.newAgent());
    await act(() => hook.result.current.save(draft));
    expect(deps.create).toHaveBeenCalledWith("agent", draft, expect.any(Promise));
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.openSession).toHaveBeenCalledWith(session);
    hook.unmount();
  });

  it("opens nothing when the create yields no session", async () => {
    const { deps, hook } = setup(null);
    act(() => hook.result.current.newAgent());
    await act(() => hook.result.current.save(draft));
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(deps.openSession).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("updates the session an edit sheet was opened on, without opening it", async () => {
    const { deps, hook } = setup();
    act(() => hook.result.current.editAgent(session));
    await act(() => hook.result.current.save(draft));
    expect(deps.update).toHaveBeenCalledWith("s1", draft, expect.any(Promise));
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.openSession).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("creates when saved with no sheet open", async () => {
    const { deps, hook } = setup();
    await act(() => hook.result.current.save(draft));
    expect(deps.create).toHaveBeenCalledWith("agent", draft, expect.any(Promise));
    hook.unmount();
  });

  it("hands the write a floor that settles after the minimum save time", async () => {
    const { deps, hook } = setup();
    act(() => hook.result.current.editAgent(session));
    await act(() => hook.result.current.save(draft));
    const floor = deps.update.mock.calls[0]?.[2] as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(MIN_SAVE_MS - 1);
    expect(await settled(floor)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(floor)).toBe(true);
    hook.unmount();
  });

  it("passes a failed create to the caller and opens nothing", async () => {
    const { deps, hook } = setup();
    deps.create.mockRejectedValueOnce(new Error("disk full"));
    act(() => hook.result.current.newAgent());
    await expect(hook.result.current.save(draft)).rejects.toThrow("disk full");
    expect(deps.openSession).not.toHaveBeenCalled();
    hook.unmount();
  });
});
