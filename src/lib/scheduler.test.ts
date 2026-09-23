import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineDraft } from "./routines";

// Hoisted so every fresh copy of the module under test (vi.resetModules) talks to this one fake.
const { fake } = await vi.hoisted(() => import("../test/fakeClient"));
vi.mock("./client", () => ({ client: fake.client }));

async function load() {
  return import("./scheduler");
}

const NOW = new Date(2026, 8, 23, 8, 0).getTime();

const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({
  key: "k1",
  sessionId: "s1",
  name: "Morning review",
  enabled: true,
  prompt: "Review yesterday's PRs",
  schedule: { kind: "interval", minutes: 30 },
  runs: [],
  ...over,
});

beforeEach(() => {
  fake.reset();
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saveRoutine", () => {
  it("persists a new draft and returns the id the daemon gave it", async () => {
    fake.respond("routine_upsert", () => ({ id: "r1" }));
    const { saveRoutine } = await load();
    expect(await saveRoutine(draft())).toBe("r1");
    expect(fake.sent("routine_upsert")).toEqual([
      {
        id: null,
        sessionId: "s1",
        name: "Morning review",
        enabled: true,
        prompt: "Review yesterday's PRs",
        schedule: JSON.stringify({ kind: "interval", minutes: 30 }),
        nextRunAt: NOW + 30 * 60_000,
      },
    ]);
  });

  it("updates an existing routine by its id", async () => {
    fake.respond("routine_upsert", () => ({ id: "r7" }));
    const { saveRoutine } = await load();
    await saveRoutine(draft({ id: "r7" }));
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ id: "r7" });
  });

  it("trims the name and prompt, and names an unnamed routine", async () => {
    fake.respond("routine_upsert", () => ({ id: "r1" }));
    const { saveRoutine } = await load();
    await saveRoutine(draft({ name: "   ", prompt: "  ship it \n" }));
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ name: "Routine", prompt: "ship it" });
  });

  it("schedules no next run for a paused routine", async () => {
    fake.respond("routine_upsert", () => ({ id: "r1" }));
    const { saveRoutine } = await load();
    await saveRoutine(draft({ enabled: false }));
    expect(fake.sent("routine_upsert")[0]).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it("tells the list to re-read once the save lands", async () => {
    const { onRoutinesChanged, saveRoutine } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    const saving = saveRoutine(draft());
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    fake.take("routine_upsert").resolve({ id: "r1" });
    await saving;
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("leaves the list alone when the save fails", async () => {
    fake.respond("routine_upsert", () => {
      throw new Error("invalid schedule");
    });
    const { onRoutinesChanged, saveRoutine } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    await expect(saveRoutine(draft())).rejects.toThrow("invalid schedule");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("removeRoutine", () => {
  it("deletes the routine and tells the list", async () => {
    fake.respond("routine_delete", () => null);
    const { onRoutinesChanged, removeRoutine } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    await removeRoutine("r1");
    expect(fake.sent("routine_delete")).toEqual([{ id: "r1" }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("leaves the list alone when the delete fails", async () => {
    fake.respond("routine_delete", () => {
      throw new Error("gone");
    });
    const { onRoutinesChanged, removeRoutine } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    await expect(removeRoutine("r1")).rejects.toThrow("gone");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("runRoutineNow", () => {
  it("asks the daemon to fire the routine and tells the list", async () => {
    fake.respond("routine_run_now", () => null);
    const { onRoutinesChanged, runRoutineNow } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    await runRoutineNow("r1");
    expect(fake.sent("routine_run_now")).toEqual([{ routineId: "r1" }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands a refusal to the caller and still tells the list", async () => {
    fake.respond("routine_run_now", () => {
      throw new Error("routine not found");
    });
    const { onRoutinesChanged, runRoutineNow } = await load();
    const listener = vi.fn();
    onRoutinesChanged(listener);
    await expect(runRoutineNow("r1")).rejects.toThrow("routine not found");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("onRoutinesChanged", () => {
  it("tells every listener, and stops telling one that unsubscribed", async () => {
    fake.respond("routine_delete", () => null);
    const { onRoutinesChanged, removeRoutine } = await load();
    const kept = vi.fn();
    const dropped = vi.fn();
    onRoutinesChanged(kept);
    const unsubscribe = onRoutinesChanged(dropped);
    await removeRoutine("r1");
    unsubscribe();
    await removeRoutine("r2");
    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});
