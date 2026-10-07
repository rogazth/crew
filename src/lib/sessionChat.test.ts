import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { SessionAsk } from "./protocol";
import { askBlock, delivered, openQuestion, overdue, queuedBlock, turnStart, underway, withAsk, type Queued } from "./sessionChat";

const user = (id: string, text: string, at: number): Block => ({ id, role: "user", text, at });
const sent = (id: string, text: string, at: number): Queued => ({ id, text, files: [], at });

describe("delivered", () => {
  it("matches a send to the user turn the CLI wrote after it", () => {
    const history = [user("old", "fix it", 1_000), user("new", "fix it", 60_000)];
    expect(delivered([sent("s", "fix it", 59_000)], history, "claude")).toEqual(new Set(["s"]));
    expect(delivered([sent("s", "fix it", 120_000)], history, "claude")).toEqual(new Set());
  });

  it("finds the text behind what the CLI put in front of it", () => {
    const history = [user("t", "[Image #1] what is this?", 10_000)];
    expect(delivered([sent("s", "what is this?", 10_000)], history, "claude").has("s")).toBe(true);
  });

  it("gives each turn to one send", () => {
    const history = [user("t", "again", 10_000)];
    expect(delivered([sent("a", "again", 9_000), sent("b", "again", 9_500)], history, "claude")).toEqual(new Set(["a"]));
  });

  it("reads a pasted message of several lines the way the CLI stored it", () => {
    const history = [user("t", "one\ntwo", 10_000)];
    expect(delivered([sent("s", "one\n two", 10_000)], history, "claude").has("s")).toBe(true);
  });

  it("matches a plugin's command typed without its plugin", () => {
    const history = [user("t", "/ns:deep look at this", 11_000)];
    expect(delivered([sent("s", "/deep look at this", 10_000)], history, "claude").has("s")).toBe(true);
    expect(delivered([sent("s", "/ns:deep look at this", 10_000)], history, "claude").has("s")).toBe(true);
  });

  it("matches a send later in the minute only for cursor", () => {
    // Monday, Aug 24, 2026, 1:05 PM (UTC-4): the start of that minute, as cursor writes it.
    const minute = 1_787_591_100_000;
    const history = [user("t", "fix it", minute)];
    const late = [sent("s", "fix it", minute + 40_000)];
    expect(delivered(late, history, "cursor").has("s")).toBe(true);
    expect(delivered(late, history, "claude").has("s")).toBe(false);
    expect(delivered(late, history, "codex").has("s")).toBe(false);
    expect(delivered([sent("s", "fix it", minute + 60_000)], history, "cursor").has("s")).toBe(false);
    // Read back inside the minute, cursor's stamp is the real time and the short slack applies.
    expect(delivered(late, [user("t", "fix it", minute + 1)], "cursor").has("s")).toBe(false);
    // Two sends in that minute take one turn each, in order.
    const both = [user("a", "again", minute), user("b", "again", minute)];
    expect(
      delivered([sent("first", "again", minute + 20_000), sent("second", "again", minute + 50_000)], both, "cursor"),
    ).toEqual(new Set(["first", "second"]));
    expect(
      delivered([sent("first", "again", minute + 20_000), sent("second", "again", minute + 50_000)], [user("t", "again", minute)], "cursor"),
    ).toEqual(new Set(["first"]));
  });
});

describe("queuedBlock", () => {
  it("is a user bubble marked as not in the history yet", () => {
    const block = queuedBlock(sent("s", "hello", 5));
    expect(block).toMatchObject({ role: "user", text: "hello", streaming: true });
    expect(block.files).toBeUndefined();
  });
});

const bash: SessionAsk = { id: 7, tool: "Bash", input: { command: "ls" }, questions: [], always: true };
const form: SessionAsk = {
  id: 8,
  tool: "AskUserQuestion",
  input: {},
  questions: [{ question: "Tea or coffee?", header: "Drink", multiSelect: false, options: [{ label: "Tea" }] }],
  always: false,
};

describe("askBlock", () => {
  it("turns a permission into an approval card answered by the ask's id", () => {
    expect(askBlock(bash, [])).toMatchObject({ role: "approval", approval: { requestId: 7, name: "Bash" } });
  });

  it("turns a question form into a question card", () => {
    expect(askBlock(form, [])).toMatchObject({ role: "question", question: { requestId: 8 } });
  });

  it("leaves a question to the card the history already shows open", () => {
    const open: Block = { id: "q", role: "question", text: "Drink", question: { requestId: 1, questions: form.questions } };
    expect(askBlock(form, [open])).toBeNull();
    const answered = { ...open, question: { ...open.question!, answers: { "Tea or coffee?": "Tea" } } };
    expect(openQuestion([answered])).toBeNull();
    expect(askBlock(form, [answered])?.role).toBe("question");
  });
});

describe("withAsk", () => {
  const call = (status: "pending" | "completed"): Block => ({
    id: "call",
    role: "tool",
    text: "ls",
    tool: { callId: "t1", name: "Bash", title: "ls", status },
  });

  it("puts a permission in the place of the call it is about", () => {
    const shown = withAsk([user("u", "list", 1), call("pending")], bash);
    expect(shown.map((block) => block.role)).toEqual(["user", "approval"]);
  });

  it("adds it at the end when no pending call of that tool is there", () => {
    expect(withAsk([call("completed")], bash).map((block) => block.role)).toEqual(["tool", "approval"]);
  });

  it("leaves the blocks as they are with nothing asked", () => {
    expect(withAsk([call("pending")], null)).toHaveLength(1);
  });
});

/** A reply that closes its turn: the block its footer hangs on. */
const ended = (id: string, at: number): Block => ({
  id,
  role: "assistant",
  text: "done",
  at,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 },
});

describe("turnStart (plan §7c-2)", () => {
  const MIN = 60_000;

  it("dates the turn from the history's newest user turn, not from a stale queued bubble", () => {
    // A paste that never matched sits queued from 20 minutes ago; the new
    // message is in the history and its turn is running.
    const stale = queuedBlock(sent("old", "<pasted>", 0));
    const blocks = [user("u1", "first", 0), ended("a1", 5 * MIN), user("u2", "short one", 20 * MIN), stale];
    expect(turnStart(blocks)).toBe(20 * MIN);
  });

  it("takes a queued message's send time only while the history has no newer user turn", () => {
    const blocks = [user("u1", "first", 0), ended("a1", 5 * MIN), queuedBlock(sent("q", "next", 6 * MIN))];
    expect(turnStart(blocks)).toBe(6 * MIN);
    // Sent while a turn ran: that turn's own start stands.
    const busy = [user("u1", "first", 0), queuedBlock(sent("q", "next", 2 * MIN))];
    expect(turnStart(busy)).toBe(0);
  });

  it("counts a turn the CLI started by itself from the end of the last one", () => {
    expect(turnStart([user("u1", "go", 0), ended("a1", 5 * MIN)])).toBe(5 * MIN);
    expect(turnStart([])).toBeUndefined();
  });
});

describe("underway", () => {
  it("is the message the agent is working on before the history has the turn", () => {
    const blocks = [queuedBlock(sent("s", "the odyssey", 8_000))];
    expect(underway(blocks, true)?.id).toBe("queued:s");
    expect(underway(blocks, false)).toBeUndefined();
  });

  it("leaves a follow-up queued while a turn already in the history is running", () => {
    const blocks = [user("u", "first", 1_000), queuedBlock(sent("s", "and this", 5_000))];
    expect(underway(blocks, true)).toBeUndefined();
  });

  it("takes the earliest send and leaves a later one waiting", () => {
    const blocks = [
      user("u", "done", 0),
      ended("a", 5_000),
      queuedBlock(sent("first", "go", 8_000)),
      queuedBlock(sent("second", "also", 9_000)),
    ];
    expect(underway(blocks, true)?.id).toBe("queued:first");
  });
});

describe("overdue", () => {
  it("drops a queued message once a turn written after it has ended", () => {
    const queued = [sent("joined", "first part", 1_000)];
    // The CLI joined it to the next message: no match, but that turn ran and ended.
    const running = [user("t", "first part\nsecond part", 2_000)];
    expect(overdue(queued, running)).toEqual(new Set());
    expect(overdue(queued, [...running, ended("a", 9_000)])).toEqual(new Set(["joined"]));
  });

  it("keeps one sent into a turn that is still the one running or just ended", () => {
    const queued = [sent("s", "and this", 5_000)];
    expect(overdue(queued, [user("t", "start", 1_000), ended("a", 8_000)])).toEqual(new Set());
  });
});
