import { describe, expect, it } from "vitest";
import { applyEvent, isOpen, newBlock, settleTurn, type Block, type Question } from "./blocks";

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
