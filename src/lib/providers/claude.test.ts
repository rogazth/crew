import { describe, expect, it } from "vitest";
import {
  alwaysAllowRule,
  parseControlRequest,
  parseQuestions,
  toPermissionResult,
  toQuestionResult,
} from "./claude";

/** Captured from claude 2.1.259; see notes/claude-permissions-protocol.jsonl. */
const ASK = {
  type: "control_request",
  request_id: "c909",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        { question: "Pick a color", header: "Color", options: [{ label: "Red", description: "Red" }, { label: "Blue", description: "Blue" }], multiSelect: false },
        { question: "Pick toppings", header: "Toppings", options: [{ label: "Cheese", description: "Cheese" }], multiSelect: true },
      ],
    },
    tool_use_id: "toolu_1",
    requires_user_interaction: true,
  },
};

describe("AskUserQuestion", () => {
  it("parses the captured request", () => {
    const control = parseControlRequest(ASK);
    expect(control?.toolName).toBe("AskUserQuestion");
    const questions = parseQuestions(control!.input);
    expect(questions).toEqual([
      { question: "Pick a color", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Pick toppings", header: "Toppings", multiSelect: true, options: [{ label: "Cheese" }] },
    ]);
  });

  it("keeps a description only when it says more than the label", () => {
    const [q] = parseQuestions({ questions: [{ question: "Q", options: [{ label: "A", description: "Do the A thing" }] }] });
    expect(q?.options[0]).toEqual({ label: "A", description: "Do the A thing" });
    expect(q?.header).toBe("Q");
  });

  it("is not a question without options", () => {
    expect(parseQuestions({ command: "ls" })).toEqual([]);
    expect(parseQuestions({ questions: [{ question: "Q", options: [] }] })).toEqual([]);
  });

  it("answers by echoing the input plus answers", () => {
    const input = ASK.request.input;
    expect(toQuestionResult(input, { "Pick a color": "Red", "Pick toppings": "Cheese, Olives" })).toEqual({
      behavior: "allow",
      updatedInput: { ...input, answers: { "Pick a color": "Red", "Pick toppings": "Cheese, Olives" } },
    });
    expect(toQuestionResult(input, null).behavior).toBe("deny");
  });
});

describe("permissions", () => {
  it("allows with the input untouched", () => {
    expect(toPermissionResult("allow", { command: "ls" }, "Bash")).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
  });

  it("always: adds a session rule on the program for Bash", () => {
    const result = toPermissionResult("always", { command: "curl -s https://x" }, "Bash");
    expect(result.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl:*" }], behavior: "allow", destination: "session" },
    ]);
  });

  it("always: names the tool for everything else", () => {
    expect(alwaysAllowRule("Edit", { file_path: "a.ts" })).toEqual({
      type: "addRules",
      rules: [{ toolName: "Edit" }],
      behavior: "allow",
      destination: "session",
    });
  });
});
