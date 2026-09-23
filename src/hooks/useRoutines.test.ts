// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineRow, ScheduledRoutine } from "../lib/routines";
import { removeRoutine } from "../lib/scheduler";
import type { Session } from "../lib/types";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useRoutines } from "./useRoutines";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

const owner: Session = {
  id: "s1",
  workspaceId: "w1",
  kind: "agent",
  name: "Planner",
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

function scheduled(id: string, runsJson = "[]"): ScheduledRoutine {
  const routine: RoutineRow = {
    id,
    sessionId: owner.id,
    name: `routine ${id}`,
    enabled: true,
    prompt: "check",
    schedule: '{"kind":"interval","minutes":30}',
    lastRunAt: null,
    nextRunAt: null,
    runsJson,
    createdBy: null,
  };
  return { routine, session: owner, cwd: "/code/crew" };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function answer(value: ScheduledRoutine[]) {
  fake.take("routine_list").resolve(value);
  await settle();
}

beforeEach(() => fake.reset());

describe("useRoutines", () => {
  it("is null while loading, then every routine with its runs parsed", async () => {
    const hook = renderHook(() => useRoutines());
    expect(hook.result.current).toBeNull();

    const run = { id: "r", startedAt: 1, finishedAt: 2, status: "ok", trigger: "manual" };
    await answer([scheduled("a", JSON.stringify([run])), scheduled("b", "not json")]);

    const [first, second] = hook.result.current ?? [];
    expect(first?.routine).toMatchObject({ id: "a", name: "routine a", runs: [run] });
    expect(first?.routine).not.toHaveProperty("runsJson");
    expect(first?.session).toBe(owner);
    expect(first?.cwd).toBe("/code/crew");
    expect(second?.routine.runs).toEqual([]);
    hook.unmount();
  });

  it("shows an empty list when the load fails", async () => {
    const hook = renderHook(() => useRoutines());
    fake.take("routine_list").reject(new Error("down"));
    await settle();
    expect(hook.result.current).toEqual([]);
    hook.unmount();
  });

  it("reads again after the screen saves or deletes one", async () => {
    fake.respond("routine_delete", () => undefined);
    const hook = renderHook(() => useRoutines());
    await answer([scheduled("a"), scheduled("b")]);

    await act(async () => removeRoutine("a"));
    expect(fake.sent("routine_delete")).toEqual([{ id: "a" }]);
    await answer([scheduled("b")]);

    expect(hook.result.current?.map((entry) => entry.routine.id)).toEqual(["b"]);
    hook.unmount();
  });

  it("reads again when the daemon says a run moved the history", async () => {
    const hook = renderHook(() => useRoutines());
    await answer([scheduled("a")]);

    act(() => fake.emit("routines-changed", null));
    const run = { id: "r", startedAt: 1, finishedAt: null, status: "running", trigger: "schedule" };
    await answer([scheduled("a", JSON.stringify([run]))]);

    expect(hook.result.current?.[0]?.routine.runs).toEqual([run]);
    hook.unmount();
  });

  it("stops listening on unmount", async () => {
    fake.respond("routine_delete", () => undefined);
    const hook = renderHook(() => useRoutines());
    await answer([]);
    expect(fake.listening("routines-changed")).toBe(1);

    hook.unmount();
    expect(fake.listening("routines-changed")).toBe(0);
    await removeRoutine("a");
    expect(fake.sent("routine_list")).toHaveLength(1);
  });

  it("drops an answer that lands after unmount", async () => {
    const hook = renderHook(() => useRoutines());
    const pending = fake.take("routine_list");
    hook.unmount();
    const renders = hook.renders();
    pending.resolve([scheduled("a")]);
    await settle();
    expect(hook.renders()).toBe(renders);
  });

  it("drops a failure that lands after unmount", async () => {
    const hook = renderHook(() => useRoutines());
    const pending = fake.take("routine_list");
    hook.unmount();
    const renders = hook.renders();
    pending.reject(new Error("late"));
    await settle();
    expect(hook.renders()).toBe(renders);
  });
});
