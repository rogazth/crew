import { describe, expect, it } from "vitest";
import { applyEvent, settleTurn, type Block, type HarnessEvent } from "./blocks";
import { currentStep, shownSteps, subagentSuffix, subagentView } from "./subagent";
import { foldTurns, groupRows, type Row } from "./transcriptRows";

const AGENT = { kind: "agent", description: "Find the parser", agentType: "Explore", prompt: "Where is it?" } as const;

function run(events: HarnessEvent[], start: Block[] = []): Block[] {
  return events.reduce(applyEvent, start);
}

const step = (callId: string, event: HarnessEvent): HarnessEvent => ({ type: "subagent.event", callId, event });

const read = (id: string, path: string): HarnessEvent => ({
  type: "tool.started",
  callId: id,
  name: "Read",
  title: `Read ${path}`,
  detail: { kind: "file", path },
});

const done = (id: string): HarnessEvent => ({ type: "tool.updated", callId: id, status: "completed" });

function agentOf(blocks: Block[]) {
  const block = blocks.find((b) => b.tool?.detail?.kind === "agent")!;
  const detail = block.tool!.detail as Extract<NonNullable<NonNullable<Block["tool"]>["detail"]>, { kind: "agent" }>;
  return { block, detail };
}

const kinds = (rows: Row[]) => rows.map((row) => row.kind);

describe("a subagent's steps", () => {
  it("nest under its call, never beside the agent's own rows", () => {
    const blocks = run([
      { type: "user.message", text: "find the parser" },
      { type: "tool.started", callId: "a1", name: "Agent", title: "Find the parser", detail: AGENT },
      step("a1", read("s1", "/w/src/parse.ts")),
      { type: "message.delta", text: "While it looks" },
      step("a1", { type: "message.delta", text: "It is in parse.ts." }),
      step("a1", { type: "message.completed" }),
      { type: "message.delta", text: ", I wait." },
      step("a1", done("s1")),
    ]);
    expect(blocks.map((b) => b.role)).toEqual(["user", "tool", "assistant"]);
    // The agent's reply streamed on in one piece around the subagent's words.
    expect(blocks[2]!.text).toBe("While it looks, I wait.");
    const { detail } = agentOf(blocks);
    expect(detail.state).toBe("running");
    expect(detail.steps!.map((s) => [s.role, s.tool?.status ?? s.text])).toEqual([
      ["tool", "completed"],
      ["assistant", "It is in parse.ts."],
    ]);
  });

  it("survive the call's own updates, which know nothing of them", () => {
    const blocks = run([
      { type: "tool.started", callId: "a1", name: "Agent", title: "Find the parser", detail: AGENT },
      step("a1", read("s1", "/w/a.ts")),
      { type: "subagent.updated", callId: "a1", activity: "Reading a.ts" },
      { type: "tool.updated", callId: "a1", status: "completed", detail: { ...AGENT, output: "In a.ts" } },
    ]);
    const { detail } = agentOf(blocks);
    expect(detail.output).toBe("In a.ts");
    expect(detail.steps).toHaveLength(1);
    expect(detail.activity).toBe("Reading a.ts");
  });

  it("keep running past the turn that started them, and stop with the process", () => {
    const started = run([
      { type: "tool.started", callId: "a1", name: "Agent", title: "Watch", detail: { ...AGENT, background: true } },
      { type: "tool.updated", callId: "a1", status: "completed" },
      step("a1", read("s1", "/w/a.ts")),
      { type: "turn.completed" },
    ]);
    expect(agentOf(started).detail.steps![0]!.tool!.status).toBe("pending");
    expect(subagentView(agentOf(started).block)!.state).toBe("running");
    const later = run([step("a1", done("s1")), step("a1", read("s2", "/w/b.ts"))], started);
    expect(agentOf(later).detail.steps!.map((s) => s.tool!.status)).toEqual(["completed", "pending"]);
    const ended = settleTurn(later, "interrupted");
    expect(agentOf(ended).detail.state).toBe("stopped");
    expect(agentOf(ended).detail.steps!.map((s) => s.tool!.status)).toEqual(["completed", "interrupted"]);
  });

  it("settle when it reports, with its report as the output", () => {
    const blocks = run([
      { type: "tool.started", callId: "a1", name: "Agent", title: "Watch", detail: { ...AGENT, background: true } },
      step("a1", read("s1", "/w/a.ts")),
      { type: "subagent.updated", callId: "a1", activity: "Reading a.ts" },
      { type: "subagent.updated", callId: "a1", state: "done", output: "alpha" },
    ]);
    const { block, detail } = agentOf(blocks);
    expect(detail.steps![0]!.tool!.status).toBe("completed");
    expect(detail.output).toBe("alpha");
    expect(subagentView(block)).toEqual({ state: "done", current: null, steps: 1, background: true });
  });

  it("ignores what is not a step, and a call it does not know", () => {
    const start = run([{ type: "tool.started", callId: "a1", name: "Agent", title: "x", detail: AGENT }]);
    const after = run(
      [
        step("a1", { type: "user.message", text: "its prompt" }),
        step("a1", { type: "turn.completed" }),
        step("nobody", { type: "message.delta", text: "lost" }),
      ],
      start,
    );
    expect(agentOf(after).detail.steps ?? []).toEqual([]);
    expect(after).toHaveLength(1);
  });
});

describe("the subagent's line", () => {
  it("says what it is on now, from the CLI or from its newest step", () => {
    const base = run([
      { type: "tool.started", callId: "a1", name: "Agent", title: "x", detail: AGENT },
      step("a1", read("s1", "/w/src/lib/transcriptRows.ts")),
    ]);
    expect(subagentView(agentOf(base).block)!.current).toBe("Reading transcriptRows.ts");
    const told = run([{ type: "subagent.updated", callId: "a1", activity: "Searching for groupRows" }], base);
    expect(subagentView(agentOf(told).block)!.current).toBe("Searching for groupRows");
  });

  it("reads each kind of step in the present tense", () => {
    const tool = (detail: NonNullable<NonNullable<Block["tool"]>["detail"]>): Block => ({
      id: "s",
      role: "tool",
      text: "t",
      tool: { callId: "s", name: "x", title: "t", status: "pending", detail },
    });
    expect(currentStep([tool({ kind: "command", command: "npm test\nnpm run lint" })])).toBe("Running npm test");
    expect(currentStep([tool({ kind: "search", query: "groupRows" })])).toBe("Searching groupRows");
    expect(currentStep([tool({ kind: "edit", path: "/w/a.ts" })])).toBe("Editing a.ts");
    expect(currentStep([{ id: "m", role: "assistant", text: "## Plan\nfirst" }])).toBe("Plan");
    expect(currentStep([])).toBeNull();
  });

  it("counts its calls, not its words", () => {
    const blocks = run([
      { type: "tool.started", callId: "a1", name: "Agent", title: "x", detail: AGENT },
      step("a1", read("s1", "/w/a.ts")),
      step("a1", { type: "message.delta", text: "hm" }),
      step("a1", read("s2", "/w/b.ts")),
    ]);
    const view = subagentView(agentOf(blocks).block)!;
    expect(view.steps).toBe(2);
    expect(subagentSuffix(agentOf(blocks).detail, view.steps)).toBe("Explore · 2 steps");
    expect(subagentSuffix({ ...AGENT, agentType: undefined } as never, 1)).toBe("subagent · 1 step");
    expect(subagentSuffix(AGENT, 0)).toBe("Explore");
  });

  it("falls back on the call's own status when the CLI never said", () => {
    const view = (status: "pending" | "completed" | "failed" | "interrupted", extra = {}) =>
      subagentView({
        id: "a",
        role: "tool",
        text: "x",
        tool: { callId: "a", name: "Agent", title: "x", status, detail: { ...AGENT, ...extra } },
      })!.state;
    expect(view("pending")).toBe("running");
    expect(view("completed")).toBe("done");
    expect(view("failed")).toBe("failed");
    expect(view("interrupted")).toBe("stopped");
    // A background call returns at once: until its report, it is still at work.
    expect(view("completed", { background: true })).toBe("running");
    expect(view("completed", { background: true, output: "done" })).toBe("done");
  });
});

describe("rows", () => {
  const turn = (subagent: Block) => [
    { id: "u", role: "user", text: "look" } as Block,
    { id: "t1", role: "tool", text: "ls", tool: { callId: "t1", name: "Bash", title: "ls", status: "completed" } } as Block,
    { id: "m", role: "assistant", text: "Checking." } as Block,
    subagent,
    { id: "t2", role: "tool", text: "pwd", tool: { callId: "t2", name: "Bash", title: "pwd", status: "completed" } } as Block,
    { id: "r", role: "assistant", text: "Sent it off." } as Block,
  ];
  const call = (extra = {}): Block => ({
    id: "a",
    role: "tool",
    text: "Find the parser",
    tool: {
      callId: "a1",
      name: "Agent",
      title: "Find the parser",
      status: "completed",
      detail: {
        ...AGENT,
        ...extra,
        steps: [{ id: "s", role: "assistant", text: "This is the subagent talking, not the reply." }],
      },
    },
  });

  it("fold a foreground subagent with the turn's work; its words are never the reply", () => {
    const rows = foldTurns(groupRows(turn(call())), false);
    expect(kinds(rows)).toEqual(["message", "fold", "message"]);
    expect((rows[2] as { block: Block }).block.text).toBe("Sent it off.");
  });

  it("keep a background subagent on the rail, out of the fold, where it goes on working", () => {
    const rows = foldTurns(groupRows(turn(call({ background: true }))), false);
    expect(kinds(rows)).toEqual(["message", "fold", "subagent", "message"]);
    // The tray knows it too: a call the tray holds is one, flagged or not.
    const tray = foldTurns(groupRows(turn(call()), new Set(["a1"])), false);
    expect(kinds(tray)).toEqual(["message", "fold", "subagent", "message"]);
  });
});

describe("the opened row", () => {
  it("does not list its report twice: as its last words and as what came back", () => {
    const steps: Block[] = [
      { id: "s1", role: "tool", text: "Read a.ts", tool: { callId: "s1", name: "Read", title: "Read a.ts", status: "completed" } },
      { id: "s2", role: "assistant", text: "It is in a.ts, line 4." },
    ];
    expect(shownSteps({ ...AGENT, steps, output: "It is in a.ts, line 4." }).map((s) => s.id)).toEqual(["s1"]);
    expect(shownSteps({ ...AGENT, steps, output: "Something else." }).map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(shownSteps({ ...AGENT, steps }).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});
