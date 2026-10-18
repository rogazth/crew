import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { ToolDetail } from "./protocol";
import { agentMeta, exitedless, optionless, askOf, isQuickQuestion, controlOf, deliveryNote, envelopeOf, firstLine, foldsLongText, nativeName, nativeReport, sentOf, startedOf, startedSessionsSentence } from "./orchestration";
import { foldTurns, groupRows, speaker, type Row } from "./transcriptRows";

const tool = (detail: ToolDetail): Block => ({
  id: "t",
  role: "tool",
  text: "",
  tool: { callId: "c", name: "x", title: "x", status: "completed", detail },
});

describe("agent cards", () => {
  it("says tokens and where it stands, with how long it took once it ended", () => {
    expect(agentMeta({ state: "done", tokens: 31_000, startedAt: 0, endedAt: 48_000 })).toBe("31k tokens · done after 48s");
    expect(agentMeta({ state: "running", activity: "Editing policy.rs" })).toBe("Editing policy.rs");
    expect(agentMeta({ state: "running" })).toBe("running");
    expect(agentMeta({ state: "failed", startedAt: 0, endedAt: 5_000 })).toBe("failed after 5s");
    expect(agentMeta({ state: "stopped" })).toBe("stopped");
  });

  it("takes the first line with words in it", () => {
    expect(firstLine("\n\n  Find every caller\nmore")).toBe("Find every caller");
  });

  it("names a native subagent by its type, else what it was for", () => {
    expect(nativeName({ kind: "agent", description: "Explore the repo", agentType: "Explore" })).toBe("Explore");
    expect(nativeName({ kind: "agent", description: "Explore the repo" })).toBe("Explore the repo");
  });

  it("has a report only once the call brought something back", () => {
    expect(nativeReport(tool({ kind: "agent", description: "d", output: "  4 callers " }))).toBe("4 callers");
    expect(nativeReport(tool({ kind: "agent", description: "d" }))).toBeNull();
  });
});

describe("long text", () => {
  it("folds after seven lines, with two lines of slack", () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
    expect(foldsLongText(lines(9))).toBe(false);
    expect(foldsLongText(lines(10))).toBe(true);
  });
});

describe("what a Crew call started", () => {
  it("reads delegate as a subagent, start_session as a session and start_sessions as several", () => {
    const message = (what: string) => tool({ kind: "message", to: "scout", text: "go", what, toId: "s1", toName: "Scout" });
    expect(startedOf(message("start"))).toMatchObject({ kind: "subagent", target: { id: "s1", name: "Scout" } });
    expect(startedOf(message("launch"))).toMatchObject({ kind: "session" });
    expect(startedOf(message("handoff"))).toBeNull();
    expect(startedOf(tool({ kind: "message", to: "x", text: "", what: "start", error: "no" }))).toBeNull();
    expect(startedOf(tool({ kind: "crew", verb: "start_sessions", targets: [{ name: "a" }] }))).toMatchObject({ kind: "sessions" });
    expect(startedOf(tool({ kind: "crew", verb: "read_session", targets: [] }))).toBeNull();
  });

  it("counts the sessions that started and the ones that did not", () => {
    expect(startedSessionsSentence([{ name: "a" }, { name: "b" }, { name: "c" }])).toBe("Started 3 sessions");
    expect(startedSessionsSentence([{ name: "a" }, { name: "b", note: "no repo" }])).toBe("Started 1 session, 1 failed");
  });
});

describe("the rows a transcript groups into", () => {
  let next = 0;
  const block = (role: Block["role"], text: string, extra: Partial<Block> = {}): Block => {
    next += 1;
    return { id: `b${next}`, role, text, ...extra };
  };
  const kinds = (rows: Row[]) => rows.map((row) => row.kind);
  const call = (name: string, detail: ToolDetail, status: "pending" | "completed" = "completed") =>
    block("tool", name, { tool: { callId: `c${next}`, name, title: name, status, detail } });
  const agent = (extra: Record<string, unknown> = {}) =>
    call("Task", { kind: "agent", description: "Explore", prompt: "Look around", ...extra } as never);
  const scout = { id: "s1", name: "scout", kind: "session" };

  it("draws a native subagent call as a row of its own, foreground or background, out of the group around it", () => {
    const rows = groupRows([block("tool", "npm test"), agent(), agent({ background: true }), block("tool", "npm run lint")]);
    expect(kinds(rows)).toEqual(["activity", "subagent", "subagent", "activity"]);
  });

  it("draws delegate, start_session and start_sessions as started rows, and keeps a handoff and a refusal as they were", () => {
    const start = (what: string, extra: Record<string, unknown> = {}) =>
      call("delegate", { kind: "message", to: "scout", text: "go", what, letterId: `L${next}`, toId: `s${next}`, toName: "scout", ...extra } as never);
    const rows = groupRows([
      start("start"),
      start("launch"),
      call("start_sessions", { kind: "crew", verb: "start_sessions", targets: [{ id: "a", name: "a" }, { name: "b", note: "no repo" }] }),
      start("handoff"),
      start("start", { error: "nope", letterId: undefined }),
    ]);
    expect(kinds(rows)).toEqual(["started", "started", "started", "letter", "refused"]);
  });

  it("drops the note a start leaves, by the letter or by the session it names", () => {
    const delegated = call("delegate", { kind: "message", to: "scout", text: "go", what: "start", letterId: "L1", toId: "s1", toName: "scout" });
    const unanswered = call("delegate", { kind: "message", to: "lint", text: "go", what: "start" }, "pending");
    const rows = groupRows([
      delegated,
      block("system", "Delegated to subagent scout (s1)", { letterId: "L1" }),
      unanswered,
      block("system", "Delegated to subagent lint (s2)", { letterId: "L2" }),
    ]);
    // The second note stays: no row names s2, and it is the only trace the start left.
    expect(kinds(rows)).toEqual(["started", "started", "letter"]);
  });

  it("draws a report letter as a report row, and a plain letter as a letter", () => {
    const report = block("user", "4 callers", { fromBot: scout, letterId: "L9", letterKind: "report" });
    const plain = block("user", "fyi", { fromBot: scout, letterId: "L10", letterKind: "message" });
    const rows = groupRows([report, plain]);
    expect(kinds(rows)).toEqual(["report", "letter"]);
    expect(speaker(rows[0]!)).toBe("meta");
  });

  it("still starts a turn at a report, and leaves a subagent, a start and a report on the rail when the turn folds", () => {
    const report = block("user", "done", { fromBot: scout, letterId: "L9", letterKind: "report" });
    const rows = foldTurns(
      groupRows([
        block("user", "go", { at: 1_000 }),
        block("tool", "a"),
        agent(),
        call("delegate", { kind: "message", to: "x", text: "go", what: "start", letterId: "L1" }),
        block("tool", "b"),
        block("assistant", "all done", { at: 5_000 }),
        report,
        block("assistant", "thanks", { at: 6_000 }),
      ]),
      false,
    );
    expect(kinds(rows)).toEqual(["date", "message", "fold", "subagent", "started", "message", "report", "message"]);
  });
});

describe("control rows", () => {
  const crew = (verb: string, rest: Partial<Extract<ToolDetail, { kind: "crew" }>> = {}): Block =>
    tool({ kind: "crew", verb, targets: [{ id: "s1", name: "billing-ui" }], ...rest });
  const sentence = (block: Block) => {
    const control = controlOf(block);
    return control ? `${control.before}${control.target ? ` [${control.target.name}]` : ""}${control.after}` : null;
  };

  it("says each verb in one line", () => {
    expect(sentence(crew("interrupt_session", { text: "use the component" }))).toBe("Interrupted [billing-ui] and redirected it");
    expect(sentence(crew("interrupt_session"))).toBe("Interrupted [billing-ui]");
    expect(sentence(crew("interrupt_session", { note: "idle" }))).toBe("Interrupted [billing-ui] · it was idle");
    expect(sentence(crew("read_session", { count: 12 }))).toBe("Read [billing-ui]'s last 12 messages");
    expect(sentence(crew("read_session", { count: 1 }))).toBe("Read [billing-ui]'s last message");
    expect(sentence(tool({ kind: "crew", verb: "list_peers", targets: [], count: 7, note: "3 sessions, 1 subagent, 3 bots" }))).toBe(
      "Listed 7 peers · 3 sessions, 1 subagent, 3 bots",
    );
    expect(sentence(crew("stop_session", { count: 2 }))).toBe("Stopped [billing-ui] and its 2 subagents");
    expect(sentence(crew("stop_session", { count: 0 }))).toBe("Stopped [billing-ui]");
    expect(sentence(crew("update_session", { note: "rename", text: "ui" }))).toBe("Renamed [billing-ui] to ui");
    expect(sentence(crew("update_session", { note: "delete", count: 0 }))).toBe("Deleted [billing-ui] · its worktree stays");
  });

  it("has a card only for an interrupt's redirect, and leaves a failed call to the generic row", () => {
    expect(controlOf(crew("interrupt_session", { text: "go on" }))?.text).toBe("go on");
    expect(controlOf(crew("read_session", { count: 3 }))?.text).toBeUndefined();
    const failed = crew("stop_session");
    failed.tool!.status = "failed";
    expect(controlOf(failed)).toBeNull();
    expect(controlOf(crew("start_sessions"))).toBeNull();
  });

  it("groups a control call into a row of its own", () => {
    expect(groupRows([crew("read_session", { count: 3 })]).map((row) => row.kind)).toEqual(["control"]);
  });
});

describe("messages", () => {
  const message = (rest: Partial<Extract<ToolDetail, { kind: "message" }>>) =>
    tool({ kind: "message", to: "docs-sweep", text: "Keep the limit", letterId: "L1", toId: "s2", toName: "docs-sweep", ...rest });

  it("says how a send went over", () => {
    expect(deliveryNote("steered")).toBe("read mid-turn");
    expect(deliveryNote("queued")).toBe("queued");
    expect(deliveryNote("started")).toBe("started a turn");
    expect(deliveryNote("answered")).toBe("answered its question");
    expect(deliveryNote(undefined)).toBeNull();
  });

  it("reads a send_message as whom, the words and the delivery; a start or a refusal is not one", () => {
    expect(sentOf(message({ delivery: "steered" }))).toEqual({
      to: { id: "s2", name: "docs-sweep" },
      text: "Keep the limit",
      letterId: "L1",
      delivery: "read mid-turn",
      handoff: false,
    });
    expect(sentOf(message({ what: "handoff" }))?.handoff).toBe(true);
    expect(sentOf(message({ what: "start" }))).toBeNull();
    expect(sentOf(message({ error: "no such session" }))).toBeNull();
  });

  it("names a letter in by its kind", () => {
    expect(envelopeOf("message")).toEqual({ word: "wrote" });
    expect(envelopeOf("question")).toEqual({ word: "asks", tag: "waits on an answer" });
    expect(envelopeOf("started")).toEqual({ word: "started this session" });
  });
});

describe("a child's open request, as its parent's letter carries it", () => {
  const question = (text: string, options = ["Keep", "Allow"], multiSelect = false): Block => ({
    id: text,
    role: "question",
    text,
    question: { requestId: 1, questions: [{ question: text, header: "Q", multiSelect, options: options.map((label) => ({ label })) }] },
  });
  const approval = (title: string): Block => ({ id: title, role: "approval", text: title, approval: { requestId: 2, name: "shell" } });

  it("finds the newest card whose words the letter carries", () => {
    const blocks = [question("Allow partial refunds?"), question("Which color?"), approval("touch asked.txt")];
    expect(askOf(blocks, "question", "## Question\n\n1. Allow partial refunds?")?.id).toBe("Allow partial refunds?");
    expect(askOf(blocks, "approval", "It wants to use shell: touch asked.txt")?.id).toBe("touch asked.txt");
    expect(askOf(blocks, "question", "1. Something else entirely")).toBeNull();
    expect(askOf(blocks, "approval", "1. Allow partial refunds?")).toBeNull();
  });

  it("answers with one click only a single-choice question with a few options", () => {
    expect(isQuickQuestion(question("a"))).toBe(true);
    expect(isQuickQuestion(question("a", ["1", "2", "3", "4", "5"]))).toBe(false);
    expect(isQuickQuestion(question("a", ["x"], true))).toBe(false);
    expect(isQuickQuestion(question("a", []))).toBe(false);
  });
});

describe("optionless", () => {
  it("drops the options the daemon lists under each question, and keeps the questions", () => {
    const letter = "1. Which color?\n   Options: Red (warm); Blue\n2. Ship it?\n   Options (several allowed, comma-separated): Yes; No";
    expect(optionless(letter)).toBe("1. Which color?\n2. Ship it?");
    expect(optionless("1. Free text?")).toBe("1. Free text?");
    expect(optionless("Options: not a daemon line")).toBe("Options: not a daemon line");
  });
});

describe("exitedless", () => {
  it("drops the exit lead from a report only", () => {
    const report = { id: "r", role: "user", text: "It exited (idle for 30 minutes).\n\nfound 4", letterKind: "report" } as Block;
    expect(exitedless(report)).toBe("found 4");
    const plain = { id: "p", role: "user", text: "It exited (x).", letterKind: "message" } as Block;
    expect(exitedless(plain)).toBe("It exited (x).");
  });
});
