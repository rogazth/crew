import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "./blocks";

const request = vi.fn();
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const reconnectHooks: Array<() => void> = [];

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
      reconnectHooks.push(hook);
      return () => {};
    },
    openStream: vi.fn(),
    writeStream: vi.fn(),
  },
}));

/** A daemon event, to every module that listens for it. */
function emit(event: string, payload: unknown): void {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

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
  description: "",
  notifications: true,
  autonomy: "ask" as const,
  status: "idle" as const,
  createdAt: 0,
  updatedAt: 0,
};

/** What the daemon would broadcast when a session moves. */
function status(next: string, id = agent.id): void {
  emit("session-status", { sessionId: id, status: next, updatedAt: 1 });
}

/** What transcript_tail answers with, holding these blocks. */
function tail(blocks: Block[] = [], working = false) {
  const more = { fromPos: blocks.length > 0 ? 1 : 0, toPos: blocks.length, more: false };
  return { blocks, ...more, seq: 0, working, status: working ? "working" : "idle" };
}

function paint(): void {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame();
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

describe("what send asks the daemon for", () => {
  function started(): Array<Record<string, unknown>> {
    return request.mock.calls.filter(([method]) => method === "turn_start").map(([, params]) => params);
  }

  beforeEach(() => {
    request.mockImplementation((method: string) =>
      Promise.resolve(method === "turn_start" ? { working: true } : tail()),
    );
  });

  it("sends only the options that say something", async () => {
    const settled = runtime.send(agent, "/w", "hi", [], { mentions: [] });
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    status("idle");
    expect(await settled).toBe(true);
    expect(started()[0]).toEqual({ sessionId: agent.id, cwd: "/w", text: "hi", nonce: expect.any(String) });
  });

  it("passes files, mentions, and the hidden and fresh flags along", async () => {
    const files = [{ name: "a.png", path: "/tmp/a.png" }];
    const settled = runtime.send(agent, "/w", "look", files, { mentions: ["src/a.ts"], hidden: true, fresh: true });
    await vi.waitFor(() => expect(started()).toHaveLength(1));
    status("idle");
    await settled;
    expect(started()[0]).toEqual({
      sessionId: agent.id,
      cwd: "/w",
      text: "look",
      files,
      mentions: ["src/a.ts"],
      hidden: true,
      fresh: true,
      nonce: expect.any(String),
    });
  });
});

describe("a turn that never started", () => {
  function errors(): string[] {
    paint();
    return transcript
      .read(agent.id)
      .blocks.filter((block) => block.role === "system")
      .map((block) => block.text);
  }

  it("gives up after one retry and says why", async () => {
    let starts = 0;
    request.mockImplementation((method: string) => {
      if (method !== "turn_start") return Promise.resolve(tail());
      starts += 1;
      return Promise.reject(new Error(starts === 1 ? "Crew daemon disconnected" : "Crew daemon is not connected"));
    });
    expect(await runtime.send(agent, "/tmp", "hello")).toBe(false);
    expect(starts).toBe(2);
    expect(errors()).toEqual(["Crew daemon is not connected"]);
  });

  it("shows a refusal that is not an Error as it came", async () => {
    request.mockImplementation((method: string) =>
      method === "turn_start" ? Promise.reject("Turn already running") : Promise.resolve(tail()),
    );
    expect(await runtime.send(agent, "/tmp", "hello")).toBe(false);
    expect(errors()).toEqual(["Turn already running"]);
  });
});

describe("working", () => {
  it("follows the status the daemon reports", () => {
    status("working");
    paint();
    expect(runtime.isWorking(agent.id)).toBe(true);
    status("needs-input");
    paint();
    expect(runtime.isWorking(agent.id)).toBe(true);
    status("idle");
    paint();
    expect(runtime.isWorking(agent.id)).toBe(false);
  });
});

describe("the calls a chat makes", () => {
  it("stops a turn, and shrugs off a daemon that cannot", async () => {
    request.mockRejectedValueOnce(new Error("gone"));
    await expect(runtime.stop(agent)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("turn_stop", { sessionId: agent.id });
  });

  it("hands an approval decision and a question's answers to the daemon", () => {
    runtime.respond(agent, 3, "always");
    runtime.answer(agent, 4, { "Pick a color": "Red" });
    runtime.answer(agent, 5, null);
    expect(request).toHaveBeenCalledWith("turn_respond", { sessionId: agent.id, requestId: 3, decision: "always" });
    expect(request).toHaveBeenCalledWith("turn_answer", {
      sessionId: agent.id,
      requestId: 4,
      answers: { "Pick a color": "Red" },
    });
    expect(request).toHaveBeenCalledWith("turn_answer", { sessionId: agent.id, requestId: 5, answers: null });
  });
});

describe("the provider session", () => {
  it("tells the sidebar which provider session a terminal is running", () => {
    const seen: Array<[string, unknown]> = [];
    const off = runtime.onSessionPatch((id, patch) => seen.push([id, patch]));
    runtime.bindProviderSession("t1", "prov-1");
    off();
    expect(seen).toEqual([["t1", { providerSessionId: "prov-1" }]]);
  });

  it("passes on the provider session a status event names", () => {
    const seen: unknown[] = [];
    const off = runtime.onSessionPatch((_id, patch) => seen.push(patch));
    emit("session-status", { sessionId: agent.id, status: "working", updatedAt: 5, providerSessionId: "prov-2" });
    emit("session-status", { sessionId: agent.id, status: "idle", updatedAt: 6 });
    off();
    expect(seen).toEqual([
      { status: "working", updatedAt: 5, providerSessionId: "prov-2" },
      { status: "idle", updatedAt: 6 },
    ]);
  });
});

describe("what the notification says", () => {
  it("quotes the first line of the last reply", async () => {
    request.mockResolvedValue(
      tail([
        { id: "a", role: "assistant", text: "Earlier." },
        { id: "b", role: "assistant", text: "  Fixed the bug.\nDetails below." },
        { id: "c", role: "tool", text: "npm test" },
        { id: "d", role: "assistant", text: "   " },
      ]),
    );
    await transcript.load(agent.id);
    status("done");
    expect(notify).toHaveBeenCalledWith("Planner", "Fixed the bug.");
  });

  it("says Done when the turn left no reply", () => {
    status("done");
    expect(notify).toHaveBeenCalledWith("Planner", "Done");
  });

  it("says a turn ran into an error", () => {
    status("error");
    expect(notify).toHaveBeenCalledWith("Planner", "Ran into an error");
  });

  it("says nothing for a session it was never told about", () => {
    status("needs-input", "ghost");
    status("done", "ghost");
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("requests from a running turn", () => {
  const apply = (event: unknown, sessionId = agent.id) => emit("transcript-apply", { sessionId, seq: 1, event });

  it("says what an agent off screen wants to run", () => {
    apply({ type: "approval.requested", requestId: 1, name: "Bash", title: "npm publish" });
    expect(notify).toHaveBeenCalledWith("Planner", "Wants to run: npm publish");
  });

  it("asks the first of an off-screen agent's questions", () => {
    apply({
      type: "question.requested",
      requestId: 1,
      questions: [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [] }],
    });
    expect(notify).toHaveBeenCalledWith("Planner", "Asks: Ship it?");
  });

  it("stays quiet for the chat on screen, an empty question and a stranger", () => {
    apply({ type: "question.requested", requestId: 1, questions: [] });
    apply({ type: "approval.requested", requestId: 1, name: "Bash", title: "ls" }, "ghost");
    runtime.setForeground(agent.id);
    apply({ type: "approval.requested", requestId: 2, name: "Bash", title: "ls" });
    apply({
      type: "question.requested",
      requestId: 3,
      questions: [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [] }],
    });
    apply({ type: "message.delta", text: "hi" });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("a reconnect", () => {
  it("reloads the transcript of every session it tracks", async () => {
    await runtime.reconcile([agent, { ...agent, id: "s2", name: "Coder" }]);
    request.mockClear();
    for (const hook of reconnectHooks) hook();
    await vi.waitFor(() => {
      const reloaded = request.mock.calls
        .filter(([method]) => method === "transcript_tail")
        .map(([, params]) => (params as { sessionId: string }).sessionId);
      expect(reloaded).toEqual(expect.arrayContaining([agent.id, "s2"]));
    });
    await runtime.dispose("s2");
  });
});
