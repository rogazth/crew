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

describe("turn end", () => {
  it("pins usage on the last assistant row", () => {
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
});
