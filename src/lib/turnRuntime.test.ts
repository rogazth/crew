import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const reconnects: Array<() => void> = [];

vi.mock("./client", () => ({
  client: {
    request,
    on: (event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    onReconnect: (hook: () => void) => {
      reconnects.push(hook);
      return () => {};
    },
    openStream: vi.fn(),
    writeStream: vi.fn(),
  },
}));

const notify = vi.fn();
vi.mock("./host", () => ({ notify: (...args: unknown[]) => notify(...args), dismissNotifications: vi.fn() }));
vi.mock("./notificationSound", () => ({ playSound: vi.fn() }));
vi.mock("./toasts", () => ({ showToast: vi.fn(), toastManager: { close: vi.fn() } }));

const runtime = await import("./turnRuntime");
const notifications = await import("./notifications");
const transcript = await import("./transcript");

const bot = {
  id: "s1",
  workspaceId: "w1",
  kind: "bot" as const,
  name: "Planner",
  provider: "claude",
  model: "m",
  effort: "",
  providerSessionId: null,
  worktree: null,
  description: "",
  notifications: true,
  autonomy: "ask" as const,
  status: "idle" as const,
  createdAt: 0,
  updatedAt: 0,
};

/** What the daemon would broadcast when a session moves. */
function status(next: string, id = bot.id): void {
  emit("session-status", { sessionId: id, status: next, updatedAt: 1 });
}

function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

let focused = false;

/** The transcript store paints through window, and vitest runs this file in node. */
let frames: Array<() => void> = [];

beforeEach(async () => {
  frames = [];
  vi.stubGlobal("window", {
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
  });
  focused = false;
  vi.stubGlobal("document", { hasFocus: () => focused });
  request.mockReset();
  notify.mockReset();
  notify.mockResolvedValue("shown");
  notifications.resetNotifications();
  request.mockResolvedValue({ blocks: [], seq: 0, working: false, status: "idle" });
  await runtime.dispose(bot.id);
  runtime.setForeground(null);
  await runtime.reconcile([bot]);
});

describe("send", () => {
  it("does not start a second turn while one is running", async () => {
    request.mockResolvedValue({ blocks: [], fromPos: 0, toPos: 0, more: false, seq: 0, working: true, status: "working" });
    await transcript.load(bot.id);
    request.mockClear();

    expect(await runtime.send(bot, "/tmp", "hello")).toBe(false);
    expect(request).not.toHaveBeenCalledWith("turn_start", expect.anything());
  });

  // The socket dropping says nothing about whether the daemon got the turn.
  // The nonce is what makes asking again safe, so it has to be the same one.
  it("asks again with the same nonce when the socket dropped", async () => {
    const calls: unknown[] = [];
    request.mockImplementation((method: string, params: unknown) => {
      if (method !== "turn_start") return Promise.resolve({ blocks: [], seq: 0, working: false, status: "idle" });
      calls.push(params);
      if (calls.length === 1) return Promise.reject(new Error("Crew daemon is not reachable"));
      return Promise.resolve({ sessionId: bot.id });
    });
    const settled = runtime.send(bot, "/tmp", "hello");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    status("idle");
    expect(await settled).toBe(true);
    const [first, second] = calls as Array<{ nonce: string } | undefined>;
    expect(second?.nonce).toBe(first?.nonce);
    expect(first?.nonce).toEqual(expect.any(String));
  });

  it("does not ask again when the daemon itself refused", async () => {
    let starts = 0;
    request.mockImplementation((method: string) => {
      if (method !== "turn_start") return Promise.resolve({ blocks: [], seq: 0, working: false, status: "idle" });
      starts += 1;
      return Promise.reject(new Error("Turn already running"));
    });
    expect(await runtime.send(bot, "/tmp", "hello")).toBe(false);
    expect(starts).toBe(1);
  });

  it("answers false when the turn ends in an error", async () => {
    request.mockImplementation((method: string) =>
      method === "turn_start"
        ? Promise.resolve({ sessionId: bot.id })
        : Promise.resolve({ blocks: [], seq: 0, working: false, status: "idle" }),
    );
    const settled = runtime.send(bot, "/tmp", "hello");
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("turn_start", expect.anything()));
    status("error");
    expect(await settled).toBe(false);
  });
});

describe("the status the sidebar sees", () => {
  it("shows a finished turn as done, so a closed tab is worth looking at", () => {
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    status("done");
    off();
    expect(seen).toEqual(["done"]);
  });

  // The user is already looking at it; a badge for something they watched
  // happen is noise.
  it("shows it as idle when it is the chat on screen", () => {
    runtime.setForeground(bot.id);
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    status("done");
    off();
    expect(seen).toEqual(["idle"]);
  });

  it("clears the flag when the reader finally opens the chat", () => {
    status("done");
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    runtime.setForeground(bot.id);
    off();
    expect(seen).toEqual(["idle"]);
  });

  // A failure is news like a finished turn: it does not stay on the row for good.
  it("clears a failure when the reader opens the chat", () => {
    status("error");
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    runtime.setForeground(bot.id);
    off();
    expect(seen).toEqual(["idle"]);
    expect(request).toHaveBeenCalledWith("session_mark_read", { id: bot.id });
  });

  // The turn ended while the socket was down, and its event went with it.
  it("catches up on a turn that ended during a reconnect", async () => {
    status("working");
    request.mockImplementation((method: string) =>
      Promise.resolve(
        method === "session_get"
          ? { ...bot, status: "done", updatedAt: 5 }
          : { blocks: [], seq: 0, working: false, status: "done" },
      ),
    );
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    for (const hook of reconnects) hook();
    await vi.waitFor(() => expect(seen).toEqual(["done"]));
    off();
  });
});
