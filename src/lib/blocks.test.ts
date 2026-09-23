import { describe, expect, it } from "vitest";
import {
  answerSummary,
  applyEvent,
  isOpen,
  newBlock,
  parseBlocks,
  settleTurn,
  type Block,
  type Question,
} from "./blocks";

const QUESTIONS: Question[] = [
  { question: "Pick a color", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
  { question: "Pick toppings", header: "Toppings", multiSelect: true, options: [{ label: "Cheese" }, { label: "Ham" }] },
];

function run(events: Parameters<typeof applyEvent>[1][], start: Block[] = []): Block[] {
  return events.reduce(applyEvent, start);
}

describe("streaming", () => {
  it("keeps assistant and reasoning in separate rows", () => {
    const blocks = run([
      { type: "reasoning.delta", text: "Let me " },
      { type: "reasoning.delta", text: "think." },
      { type: "message.delta", text: "Done." },
      { type: "message.delta", text: " Really." },
    ]);
    expect(blocks.map((b) => [b.role, b.text, b.streaming ?? false])).toEqual([
      ["reasoning", "Let me think.", false],
      ["assistant", "Done. Really.", true],
    ]);
  });
});

describe("questions", () => {
  it("replaces the pending AskUserQuestion tool row with the card", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "AskUserQuestion", title: "AskUserQuestion" },
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe("question");
    expect(blocks[0]?.text).toBe("Color");
    expect(isOpen(blocks[0]!)).toBe(true);
  });

  it("stores answers and closes", () => {
    const blocks = run([
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
      { type: "question.resolved", requestId: 1, answers: { "Pick a color": "Red" } },
    ]);
    expect(blocks[0]?.question?.answers).toEqual({ "Pick a color": "Red" });
    expect(isOpen(blocks[0]!)).toBe(false);
  });

  it("marks a null answer as dismissed", () => {
    const blocks = run([
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
      { type: "question.resolved", requestId: 1, answers: null },
    ]);
    expect(blocks[0]?.question?.dismissed).toBe(true);
  });

  it("dismisses an unanswered question when the turn settles", () => {
    const blocks = settleTurn(run([{ type: "question.requested", requestId: 1, questions: QUESTIONS }]), "interrupted");
    expect(blocks[0]?.question?.dismissed).toBe(true);
    expect(isOpen(blocks[0]!)).toBe(false);
  });
});

describe("approvals", () => {
  it("keeps the input and folds the allowed call into one row", () => {
    const input = { command: "npm run lint" };
    const blocks = run([
      { type: "approval.requested", requestId: 1, name: "Bash", title: "npm run lint", input },
      { type: "approval.resolved", requestId: 1, decision: "always" },
      { type: "tool.started", callId: "t1", name: "Bash", title: "npm run lint" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe("tool");
    expect(blocks[0]?.approval?.decided).toBe("always");
  });

  it("keeps a denied call as its own row", () => {
    const blocks = run([
      { type: "approval.requested", requestId: 1, name: "Bash", title: "rm -rf dist" },
      { type: "approval.resolved", requestId: 1, decision: "deny" },
      { type: "tool.started", callId: "t1", name: "Bash", title: "rm -rf dist" },
    ]);
    expect(blocks.map((b) => b.role)).toEqual(["approval", "tool"]);
  });
});

describe("daemon appends", () => {
  it("projects a user row from user.message", () => {
    const blocks = run([{ type: "user.message", text: "hi", hidden: true }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.role).toBe("user");
    expect(blocks[0]?.text).toBe("hi");
    expect(blocks[0]?.hidden).toBe(true);
  });

  it("keeps the sender on a row another agent wrote", () => {
    const blocks = run([
      { type: "user.message", text: "ping", fromAgent: { id: "a1", name: "Crew" } },
    ]);
    expect(blocks[0]?.fromAgent).toEqual({ id: "a1", name: "Crew" });
  });

  it("projects a system row from system.message", () => {
    const blocks = run([{ type: "system.message", text: "Stopped" }]);
    expect(blocks.map((b) => [b.role, b.text])).toEqual([["system", "Stopped"]]);
  });
});

describe("turn end", () => {
  it("pins usage on the reply the turn ended with", () => {
    const blocks = run(
      [
        { type: "message.delta", text: "ok" },
        { type: "turn.completed", usage: { costUsd: 0.01 } },
      ],
      [newBlock("user", "hi")],
    );
    expect(blocks.at(-1)?.usage).toEqual({ costUsd: 0.01 });
    expect(blocks.at(-1)?.streaming).toBe(false);
  });

  // An agentic run ends on its last tool call as often as on a sentence. The
  // cost is the turn's either way, and hanging it on a reply from further up
  // reads as what that reply cost — or is lost, when the window starts below it.
  it("pins usage on a tool row when the turn ended on one", () => {
    const blocks = run(
      [
        { type: "message.delta", text: "on it" },
        { type: "message.completed" },
        { type: "tool.started", callId: "c1", name: "bash", title: "npm test" },
        { type: "tool.updated", callId: "c1", status: "completed" },
        { type: "turn.completed", usage: { costUsd: 0.02 } },
      ],
      [newBlock("user", "hi")],
    );
    const last = blocks.at(-1);
    expect(last?.role).toBe("tool");
    expect(last?.usage).toEqual({ costUsd: 0.02 });
    expect(blocks.find((b) => b.role === "assistant")?.usage).toBeUndefined();
  });

  it("keeps quiet when the turn brought no usage with it", () => {
    const blocks = run([{ type: "message.delta", text: "ok" }, { type: "turn.completed" }], [
      newBlock("user", "hi"),
    ]);
    expect(blocks.at(-1)?.usage).toBeUndefined();
  });
});

describe("parseBlocks", () => {
  it("reads back a stored list and drops rows that are not blocks", () => {
    const kept: Block = { id: "a", role: "user", text: "hi" };
    const raw = JSON.stringify([kept, { id: "b", role: "user" }, { id: 1, role: "user", text: "x" }, null, "text"]);
    expect(parseBlocks(raw)).toEqual([kept]);
  });

  it("answers an empty list for nothing, junk and a non-list", () => {
    expect(parseBlocks(null)).toEqual([]);
    expect(parseBlocks(undefined)).toEqual([]);
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("{oops")).toEqual([]);
    expect(parseBlocks('{"id":"a","role":"user","text":"hi"}')).toEqual([]);
  });
});

describe("isOpen", () => {
  it("is open while a tool runs or an approval waits, and never for a message", () => {
    const [tool] = run([{ type: "tool.started", callId: "t1", name: "Bash", title: "ls" }]);
    const [approval] = run([{ type: "approval.requested", requestId: 1, name: "Bash", title: "ls" }]);
    expect(isOpen(tool!)).toBe(true);
    expect(isOpen(approval!)).toBe(true);
    expect(isOpen(newBlock("assistant", "hi"))).toBe(false);
    expect(isOpen(newBlock("approval", "no request"))).toBe(false);
    expect(isOpen(newBlock("question", "no request"))).toBe(false);
  });
});

describe("settleTurn", () => {
  it("closes a running tool with the given status and denies an unanswered approval", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "npm test" },
      { type: "approval.requested", requestId: 1, name: "Bash", title: "rm -rf dist" },
    ]);
    const settled = settleTurn(blocks, "completed");
    expect(settled[0]?.tool?.status).toBe("completed");
    expect(settled[1]?.approval?.decided).toBe("deny");
    expect(settled.some(isOpen)).toBe(false);
  });

  it("leaves a decided approval and an answered question as they were", () => {
    const blocks = run([
      { type: "approval.requested", requestId: 1, name: "Bash", title: "ls" },
      { type: "approval.resolved", requestId: 1, decision: "allow" },
      { type: "question.requested", requestId: 2, questions: QUESTIONS },
      { type: "question.resolved", requestId: 2, answers: { "Pick a color": "Red" } },
    ]);
    const settled = settleTurn(blocks, "interrupted");
    expect(settled[0]).toBe(blocks[0]);
    expect(settled[1]).toBe(blocks[1]);
  });
});

describe("tools", () => {
  it("keeps the detail the call started with", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "ls", detail: { kind: "command", command: "ls" } },
    ]);
    expect(blocks[0]?.tool?.detail).toEqual({ kind: "command", command: "ls" });
  });

  it("updates only the call it names, keeping what the update left out", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "ls" },
      { type: "tool.started", callId: "t2", name: "Read", title: "Read a.ts" },
      { type: "tool.updated", callId: "t1", title: "ls -la" },
      { type: "tool.updated", callId: "t1", status: "failed", detail: { kind: "command", command: "ls -la", exitCode: 2 } },
    ]);
    expect(blocks[0]?.text).toBe("ls -la");
    expect(blocks[0]?.tool).toMatchObject({ title: "ls -la", status: "failed", detail: { exitCode: 2 } });
    expect(blocks[1]?.tool).toMatchObject({ title: "Read a.ts", status: "pending" });
  });

  it("closes the streaming reply when a tool starts", () => {
    const blocks = run([
      { type: "message.delta", text: "Let me look" },
      { type: "tool.started", callId: "t1", name: "Bash", title: "ls" },
    ]);
    expect(blocks[0]?.streaming).toBe(false);
  });
});

describe("resolving what is not waiting", () => {
  it("leaves the list alone for an approval nobody asked for", () => {
    const blocks = run([{ type: "approval.requested", requestId: 1, name: "Bash", title: "ls" }]);
    expect(applyEvent(blocks, { type: "approval.resolved", requestId: 9, decision: "allow" })).toBe(blocks);
  });

  it("leaves the list alone for a question already answered", () => {
    const blocks = run([
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
      { type: "question.resolved", requestId: 1, answers: null },
    ]);
    expect(applyEvent(blocks, { type: "question.resolved", requestId: 1, answers: { a: "b" } })).toBe(blocks);
  });

  it("answers only the newest approval when a request id repeats across turns", () => {
    const blocks = run([
      { type: "approval.requested", requestId: 1, name: "Bash", title: "first" },
      { type: "approval.resolved", requestId: 1, decision: "allow" },
      { type: "approval.requested", requestId: 1, name: "Bash", title: "second" },
      { type: "approval.resolved", requestId: 1, decision: "cancelled" },
    ]);
    expect(blocks.map((b) => b.approval?.decided)).toEqual(["allow", "deny"]);
  });
});

describe("question cards", () => {
  it("titles the card with the question when there is no header, and says Question when there is nothing", () => {
    const [bare] = run([
      { type: "question.requested", requestId: 1, questions: [{ ...QUESTIONS[0]!, header: "" }] },
    ]);
    const [empty] = run([{ type: "question.requested", requestId: 2, questions: [] }]);
    expect(bare?.text).toBe("Pick a color");
    expect(empty?.text).toBe("Question");
  });

  it("does not swallow a pending tool that is not the question tool", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "ls" },
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
    ]);
    expect(blocks.map((b) => b.role)).toEqual(["tool", "question"]);
  });
});

describe("answerSummary", () => {
  it("joins the chosen answers in question order", () => {
    const blocks = run([
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
      { type: "question.resolved", requestId: 1, answers: { "Pick toppings": "Ham", "Pick a color": "Blue" } },
    ]);
    expect(answerSummary(blocks[0]!)).toBe("Blue · Ham");
  });

  it("skips a question left unanswered", () => {
    const blocks = run([
      { type: "question.requested", requestId: 1, questions: QUESTIONS },
      { type: "question.resolved", requestId: 1, answers: { "Pick toppings": "Cheese" } },
    ]);
    expect(answerSummary(blocks[0]!)).toBe("Cheese");
  });

  it("says Dismissed for a dismissed card and nothing for an open one or a non-question", () => {
    const open = run([{ type: "question.requested", requestId: 1, questions: QUESTIONS }]);
    const dismissed = run([{ type: "question.resolved", requestId: 1, answers: null }], open);
    expect(answerSummary(dismissed[0]!)).toBe("Dismissed");
    expect(answerSummary(open[0]!)).toBe("");
    expect(answerSummary(newBlock("assistant", "hi"))).toBe("");
  });
});

describe("session events", () => {
  it("interrupts what was running and says what went wrong", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "npm test" },
      { type: "session.error", message: "boom" },
    ]);
    expect(blocks[0]?.tool?.status).toBe("interrupted");
    expect(blocks.map((b) => [b.role, b.text])).toEqual([
      ["tool", "npm test"],
      ["system", "boom"],
    ]);
  });

  it("interrupts a running tool when the session ends, adding nothing", () => {
    const blocks = run([
      { type: "tool.started", callId: "t1", name: "Bash", title: "npm test" },
      { type: "session.ended", code: 1 },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.tool?.status).toBe("interrupted");
  });

  it("adds a note as a system row and settles the reply above it", () => {
    const blocks = run([
      { type: "message.delta", text: "half" },
      { type: "session.note", message: "Compacted" },
    ]);
    expect(blocks.map((b) => [b.role, b.text, b.streaming ?? false])).toEqual([
      ["assistant", "half", false],
      ["system", "Compacted", false],
    ]);
  });

  it("keeps the files a user attached", () => {
    const files = [{ name: "a.png", path: "/tmp/a.png" }];
    const blocks = run([{ type: "user.message", text: "look", files }]);
    expect(blocks[0]?.files).toEqual(files);
  });

  it("ignores events that do not change the transcript", () => {
    const start = [newBlock("user", "hi")];
    expect(applyEvent(start, { type: "session.started" })).toBe(start);
    expect(applyEvent(start, { type: "session.providerBound", providerSessionId: "p" })).toBe(start);
  });

  it("drops usage for a turn that has no blocks to carry it", () => {
    expect(applyEvent([], { type: "turn.completed", usage: { costUsd: 0.01 } })).toEqual([]);
  });
});
