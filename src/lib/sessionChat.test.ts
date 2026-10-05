import { describe, expect, it } from "vitest";
import type { Block } from "./blocks";
import type { SessionAsk } from "./protocol";
import { askBlock, delivered, openQuestion, queuedBlock, withAsk, type Queued } from "./sessionChat";

const user = (id: string, text: string, at: number): Block => ({ id, role: "user", text, at });
const sent = (id: string, text: string, at: number): Queued => ({ id, text, files: [], at });

describe("delivered", () => {
  it("matches a send to the user turn the CLI wrote after it", () => {
    const history = [user("old", "fix it", 1_000), user("new", "fix it", 60_000)];
    expect(delivered([sent("s", "fix it", 59_000)], history)).toEqual(new Set(["s"]));
    expect(delivered([sent("s", "fix it", 120_000)], history)).toEqual(new Set());
  });

  it("finds the text behind what the CLI put in front of it", () => {
    const history = [user("t", "[Image #1] what is this?", 10_000)];
    expect(delivered([sent("s", "what is this?", 10_000)], history).has("s")).toBe(true);
  });

  it("gives each turn to one send", () => {
    const history = [user("t", "again", 10_000)];
    expect(delivered([sent("a", "again", 9_000), sent("b", "again", 9_500)], history)).toEqual(new Set(["a"]));
  });

  it("reads a pasted message of several lines the way the CLI stored it", () => {
    const history = [user("t", "one\ntwo", 10_000)];
    expect(delivered([sent("s", "one\n two", 10_000)], history).has("s")).toBe(true);
  });

  it("matches a plugin's command typed without its plugin", () => {
    const history = [user("t", "/ns:deep look at this", 11_000)];
    expect(delivered([sent("s", "/deep look at this", 10_000)], history).has("s")).toBe(true);
    expect(delivered([sent("s", "/ns:deep look at this", 10_000)], history).has("s")).toBe(true);
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
