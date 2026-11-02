import { describe, expect, it, vi } from "vitest";
import type { RemoteEnv } from "../src/lib/protocol";
import type { RemoteUpdateResult, RemoteUpdateState } from "../src/lib/remotes";
import { remoteUpdater } from "./remote-updates";
import { lines, named } from "./trace-recorder";

vi.mock("./trace", async () => (await import("./trace-recorder")).mockedTrace());

const devbox = { id: "m1", name: "devbox", host: "100.102.48.125", port: 17877, user: "agent", ssh: "" } as RemoteEnv;

function harness(seen: { version: string; agentsRunning: number }, auto = true) {
  const published: Record<string, RemoteUpdateState>[] = [];
  const finished: RemoteUpdateResult[] = [];
  const update = vi.fn(async () => ({ warning: null }));
  const updater = remoteUpdater({
    machines: async () => [devbox],
    peek: async () => seen,
    target: async () => "0.3.29",
    auto: async () => auto,
    busy: () => false,
    update,
    publish: (states) => published.push(states),
    finished: (result) => finished.push(result),
  });
  return { updater, update, published, finished, seen };
}

describe("remote updater", () => {
  it("waits for the sessions, then runs the update the user queued", async () => {
    const run = harness({ version: "0.3.12", agentsRunning: 2 }, false);
    await run.updater.queue("m1");
    expect(run.update).not.toHaveBeenCalled();
    expect(run.updater.states().m1).toEqual({ state: "waiting", version: "0.3.29", queued: true, agentsRunning: 2 });
    run.seen.agentsRunning = 0;
    await run.updater.look();
    expect(run.update).toHaveBeenCalledOnce();
    expect(run.finished).toEqual([{ id: "m1", name: "devbox", version: "0.3.29", ok: true, message: null }]);
    expect(run.updater.states()).toEqual({});
  });

  it("does not update on its own with the setting off", async () => {
    const run = harness({ version: "0.3.12", agentsRunning: 0 }, false);
    await run.updater.look();
    expect(run.update).not.toHaveBeenCalled();
    expect(run.updater.states()).toEqual({});
  });

  it("holds a version back once the user cancels its wait", async () => {
    const run = harness({ version: "0.3.12", agentsRunning: 0 });
    await run.updater.look();
    expect(run.updater.states().m1?.state).toBe("waiting");
    run.updater.cancel("m1");
    await run.updater.look();
    expect(run.updater.states()).toEqual({});
    expect(run.update).not.toHaveBeenCalled();
  });

  it("says a failed update failed and does not retry it at once", async () => {
    const run = harness({ version: "0.3.12", agentsRunning: 0 }, false);
    run.update.mockRejectedValueOnce(new Error("Could not reach 100.102.48.125"));
    await run.updater.queue("m1");
    expect(run.finished[0]).toMatchObject({ ok: false, message: "Could not reach 100.102.48.125" });
    await run.updater.look();
    expect(run.update).toHaveBeenCalledOnce();
  });

  describe("its trace", () => {
    it("says each decision once with the machine's id and never its name or address", async () => {
      lines.length = 0;
      const run = harness({ version: "0.3.12", agentsRunning: 2 }, false);
      await run.updater.queue("m1");
      await run.updater.look();
      expect(named("update.queued")).toHaveLength(1);
      // Still waiting at the next look: one line for the stretch, not one per look.
      expect(named("update.waiting")).toHaveLength(1);
      expect(named("update.waiting")[0]?.fields).toEqual({ machine: "m1", agents_running: 2, queued: true });
      run.seen.agentsRunning = 0;
      await run.updater.look();
      expect(named("update.start")[0]?.fields).toMatchObject({ machine: "m1", from: "0.3.12", to: "0.3.29" });
      expect(named("update.done")[0]?.fields).toMatchObject({ machine: "m1", warning: false });
      expect(JSON.stringify(lines)).not.toMatch(/devbox|100\.102/);
    });

    it("says a cancelled wait, a failed update and a machine skipped as busy", async () => {
      lines.length = 0;
      const run = harness({ version: "0.3.12", agentsRunning: 0 });
      await run.updater.look();
      run.updater.cancel("m1");
      expect(named("update.cancelled")).toHaveLength(1);
      const failing = harness({ version: "0.3.12", agentsRunning: 0 }, false);
      failing.update.mockRejectedValueOnce(new Error('invalid type: string "hunter2", expected u32\nmore'));
      await failing.updater.queue("m1");
      const failed = named("update.failed")[0];
      expect(failed?.level).toBe("WARN");
      expect(failed?.fields.error).toBe('invalid type: string "…", expected u32');
      // Busy for a long stretch of looks: told once.
      lines.length = 0;
      let busy = true;
      const updater = remoteUpdater({
        machines: async () => [devbox],
        peek: async () => ({ version: "0.3.12", agentsRunning: 0 }),
        target: async () => "0.3.29",
        auto: async () => true,
        busy: () => busy,
        update: async () => ({ warning: null }),
        publish: () => {},
        finished: () => {},
      });
      await updater.look();
      await updater.look();
      await updater.look();
      expect(named("update.skipped")).toHaveLength(1);
      busy = false;
      await updater.look();
      busy = true;
      await updater.look();
      expect(named("update.skipped")).toHaveLength(2);
    });
  });
});
