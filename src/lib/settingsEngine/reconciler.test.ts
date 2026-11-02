import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SettingRow } from "../protocol";
import { isNewer } from "./plan";
import { LOCAL_ENV, Reconciler, RETRY_MS, type Machine } from "./reconciler";

/** A daemon in memory, with the rules of `settings` in crew-core. */
class FakeDaemon {
  rows = new Map<string, SettingRow>();
  state = new Map<string, string>();
  merges = 0;
  failNext = 0;
  private clock = 1000;
  constructor(readonly origin: string, readonly speaksSettings = true) {}

  answer(method: string, params: Record<string, unknown>): unknown {
    if (method === "state_get") return this.state.get(params.key as string) ?? null;
    if (method === "state_set") return void this.state.set(params.key as string, params.value as string);
    if (!this.speaksSettings) throw new Error(`Unknown method: ${method}`);
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("Connection closed");
    }
    if (method === "settings_list") return [...this.rows.values()];
    if (method === "settings_set") return this.choose(params.key as string, params.value as string | null);
    if (method === "settings_merge") {
      this.merges += 1;
      for (const row of params.rows as SettingRow[]) {
        const held = this.rows.get(row.key);
        if (!held || isNewer(row, held)) this.rows.set(row.key, row);
      }
      return [];
    }
    throw new Error(`Unknown method: ${method}`);
  }

  choose(key: string, value: string | null, revision?: number): SettingRow {
    this.clock += 1;
    const row = { key, value, scope: "global", revision: revision ?? this.clock, origin: this.origin };
    this.rows.set(key, row);
    return row;
  }
}

const KEY = "sessions:retention";

function world(remotes: Record<string, FakeDaemon>) {
  const local = new FakeDaemon("mac");
  const links = new Map<string, Machine>(
    Object.keys(remotes).map((id) => [id, { id, name: id, status: "online", mismatch: false }]),
  );
  const daemons: Record<string, FakeDaemon> = { ...remotes, [LOCAL_ENV]: local };
  const reconciler = new Reconciler({
    keys: () => [KEY],
    machines: () => [...links.values()],
    request: async <T,>(method: string, params: object, env: string) => {
      const daemon = daemons[env];
      if (!daemon) throw new Error("no such machine");
      return daemon.answer(method, params as Record<string, unknown>) as T;
    },
  });
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(1);
  };
  const setLink = (id: string, status: Machine["status"]) => {
    const link = links.get(id);
    if (link) link.status = status;
    reconciler.publish();
  };
  return { local, reconciler, settle, setLink };
}

const stateOf = (reconciler: Reconciler, id: string) => reconciler.read().find((machine) => machine.id === id)?.state;

describe("Reconciler", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  test("a choice reaches a connected machine", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    local.choose(KEY, "90");
    reconciler.kick();
    await settle();
    expect(falcon.rows.get(KEY)?.value).toBe("90");
    expect(stateOf(reconciler, "falcon")).toBe("synced");
    reconciler.stop();
  });

  test("going back to the default reaches a connected machine", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    local.choose(KEY, "90");
    reconciler.kick();
    await settle();
    local.choose(KEY, null);
    reconciler.kick();
    await settle();
    expect(falcon.rows.get(KEY)?.value).toBeNull();
    reconciler.stop();
  });

  test("a machine that was offline gets the choice when it is back, and shows as waiting until then", async () => {
    const devbox = new FakeDaemon("devbox");
    const { local, reconciler, settle, setLink } = world({ devbox });
    setLink("devbox", "offline");
    reconciler.start();
    await settle();
    local.choose(KEY, "7");
    reconciler.kick();
    await settle();
    expect(devbox.rows.get(KEY)).toBeUndefined();
    expect(stateOf(reconciler, "devbox")).toBe("offline");

    setLink("devbox", "online");
    reconciler.kick();
    await settle();
    expect(devbox.rows.get(KEY)?.value).toBe("7");
    expect(stateOf(reconciler, "devbox")).toBe("synced");
    reconciler.stop();
  });

  test("a failed push is tried again on its own, sooner than the regular pass", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    await settle();
    local.choose(KEY, "30");
    falcon.failNext = 1;
    reconciler.kick();
    await settle();
    expect(falcon.rows.get(KEY)).toBeUndefined();
    expect(stateOf(reconciler, "falcon")).toBe("failed");

    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 0);
    expect(falcon.rows.get(KEY)?.value).toBe("30");
    expect(stateOf(reconciler, "falcon")).toBe("synced");
    reconciler.stop();
  });

  test("retries back off and keep going", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    await settle();
    local.choose(KEY, "30");
    falcon.failNext = 3;
    reconciler.kick();
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_MS[0] ?? 0);
    expect(falcon.rows.get(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(RETRY_MS[1] ?? 0);
    expect(falcon.rows.get(KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(RETRY_MS[2] ?? 0);
    expect(falcon.rows.get(KEY)?.value).toBe("30");
    reconciler.stop();
  });

  test("a machine's newer choice comes back to this one", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    local.choose(KEY, "30", 100);
    falcon.choose(KEY, "90", 200);
    reconciler.start();
    await settle();
    expect(local.rows.get(KEY)?.value).toBe("90");
    reconciler.stop();
  });

  test("two machines whose copies disagree end up with the same one", async () => {
    const falcon = new FakeDaemon("falcon");
    const devbox = new FakeDaemon("devbox");
    const { local, reconciler, settle } = world({ falcon, devbox });
    falcon.choose(KEY, "7", 300);
    devbox.choose(KEY, "90", 200);
    local.choose(KEY, "30", 100);
    reconciler.start();
    await settle();
    expect([local, falcon, devbox].map((daemon) => daemon.rows.get(KEY)?.value)).toEqual(["7", "7", "7"]);
    reconciler.stop();
  });

  test("a forgotten remote value loses to this machine having none", async () => {
    const falcon = new FakeDaemon("falcon");
    falcon.choose(KEY, "90", 0);
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    await settle();
    expect(local.rows.get(KEY)?.revision).toBeGreaterThan(0);
    expect(falcon.rows.get(KEY)?.value).toBeNull();
    reconciler.stop();
  });

  test("this machine's value from before the engine reaches the others", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    local.choose(KEY, "on", 0);
    reconciler.start();
    await settle();
    expect(falcon.rows.get(KEY)?.value).toBe("on");
    reconciler.stop();
  });

  test("a machine on an older crewd is told apart from one that failed, and does not keep retrying", async () => {
    const old = new FakeDaemon("old", false);
    const { local, reconciler, settle } = world({ old });
    reconciler.start();
    local.choose(KEY, "30");
    reconciler.kick();
    await settle();
    expect(stateOf(reconciler, "old")).toBe("outdated");
    expect(vi.getTimerCount()).toBe(1);
    reconciler.stop();
  });

  test("every pass confirms each machine, with nothing to change too", async () => {
    const falcon = new FakeDaemon("falcon");
    const { reconciler, settle } = world({ falcon });
    reconciler.start();
    await settle();
    expect(falcon.merges).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(falcon.merges).toBe(2);
    reconciler.stop();
  });

  test("a change made during a pass gets a pass of its own", async () => {
    const falcon = new FakeDaemon("falcon");
    const { local, reconciler, settle } = world({ falcon });
    reconciler.start();
    local.choose(KEY, "30");
    reconciler.kick();
    await settle();
    expect(falcon.rows.get(KEY)?.value).toBe("30");
    reconciler.stop();
  });

  test("what a machine holds is remembered across a restart of the window", async () => {
    const devbox = new FakeDaemon("devbox");
    const first = world({ devbox });
    first.local.choose(KEY, "30");
    first.reconciler.start();
    await first.settle();
    first.reconciler.stop();
    expect(first.local.state.get("settings:acked:devbox")).toBeTruthy();
  });
});
