import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
const listeners = new Map<string, (payload: unknown) => void>();
const reconnects: Array<() => void> = [];

vi.mock("./client", () => ({
  client: {
    request,
    on: (event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
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
vi.mock("./notify", () => ({ notify: (...args: unknown[]) => notify(...args) }));

const runtime = await import("./agentRuntime");
const transcript = await import("./transcript");

const agent = {
  id: "s1",
  workspaceId: "w1",
  kind: "agent" as const,
  name: "Planner",
  provider: "claude",
  model: "m",
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
function status(next: string, id = agent.id): void {
  listeners.get("session-status")?.({ sessionId: id, status: next, updatedAt: 1 });
}

/** The transcript store paints through window, and vitest runs this file in node. */
let frames: Array<() => void> = [];

beforeEach(async () => {
  frames = [];
  vi.stubGlobal("window", {
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
  });
  vi.stubGlobal("document", { hasFocus: () => true });
  request.mockReset();
  notify.mockReset();
  request.mockResolvedValue({ blocks: [], seq: 0, working: false, status: "idle" });
  await runtime.dispose(agent.id);
  runtime.setForeground(null);
  await runtime.reconcile([agent]);
});

describe("send", () => {
  it("does not start a second turn while one is running", async () => {
    request.mockResolvedValue({ blocks: [], fromPos: 0, toPos: 0, more: false, seq: 0, working: true, status: "working" });
    await transcript.load(agent.id);
    request.mockClear();

    expect(await runtime.send(agent, "/tmp", "hello")).toBe(false);
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
      return Promise.resolve({ sessionId: agent.id });
    });
    const settled = runtime.send(agent, "/tmp", "hello");
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
    expect(await runtime.send(agent, "/tmp", "hello")).toBe(false);
    expect(starts).toBe(1);
  });

  it("answers false when the turn ends in an error", async () => {
    request.mockImplementation((method: string) =>
      method === "turn_start"
        ? Promise.resolve({ sessionId: agent.id })
        : Promise.resolve({ blocks: [], seq: 0, working: false, status: "idle" }),
    );
    const settled = runtime.send(agent, "/tmp", "hello");
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
    runtime.setForeground(agent.id);
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
    runtime.setForeground(agent.id);
    off();
    expect(seen).toEqual(["idle"]);
  });

  // The turn ended while the socket was down, and its event went with it.
  it("catches up on a turn that ended during a reconnect", async () => {
    status("working");
    request.mockImplementation((method: string) =>
      Promise.resolve(
        method === "session_get"
          ? { ...agent, status: "done", updatedAt: 5 }
          : { blocks: [], seq: 0, working: false, status: "done" },
      ),
    );
    const seen: string[] = [];
    const off = runtime.onSessionPatch((_id, patch) => patch.status && seen.push(patch.status));
    for (const hook of reconnects) hook();
    await vi.waitFor(() => expect(seen).toEqual(["done"]));
    off();
  });

  it("leaves a terminal's status to its terminal", async () => {
    await runtime.reconcile([{ ...agent, id: "t1", kind: "terminal" }]);
    request.mockImplementation((method: string) =>
      Promise.resolve(method === "session_get" ? { ...agent, id: "t1", kind: "terminal", status: "working" } : { blocks: [] }),
    );
    const seen: string[] = [];
    const off = runtime.onSessionPatch((id, patch) => id === "t1" && patch.status && seen.push(patch.status));
    for (const hook of reconnects) hook();
    await new Promise((resolve) => setTimeout(resolve, 10));
    off();
    expect(seen).toEqual([]);
  });
});

describe("notifications", () => {
  it("says what the agent said when the turn ends off screen", () => {
    status("done");
    expect(notify).toHaveBeenCalledWith("Planner", expect.any(String));
  });

  it("says nothing for a turn the reader watched end", () => {
    runtime.setForeground(agent.id);
    status("done");
    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing at all for an agent with notifications off", async () => {
    await runtime.reconcile([{ ...agent, notifications: false }]);
    status("done");
    status("needs-input");
    expect(notify).not.toHaveBeenCalled();
  });

  it("asks for input out loud, because nothing moves until the reader answers", () => {
    status("needs-input");
    expect(notify).toHaveBeenCalledWith("Planner", "Needs your input");
  });

  it("stays quiet when a turn simply goes idle", () => {
    status("idle");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("kills a turn that is still running and forgets the session", async () => {
    status("working");
    await runtime.dispose(agent.id);
    expect(request).toHaveBeenCalledWith("turn_stop", { sessionId: agent.id });
  });

  it("leaves an idle session's daemon alone", async () => {
    status("idle");
    request.mockClear();
    await runtime.dispose(agent.id);
    expect(request).not.toHaveBeenCalledWith("turn_stop", expect.anything());
  });
});
