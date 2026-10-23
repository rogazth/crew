import { describe, expect, it, vi } from "vitest";
import type { RemoteEnv } from "../src/lib/protocol";
import type { RemoteUpdateResult, RemoteUpdateState } from "../src/lib/remotes";
import { remoteUpdater } from "./remote-updates";

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
});
