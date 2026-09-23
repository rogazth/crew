// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answers, ApprovalDecision, Block } from "../../lib/blocks";
import { mount, press, type Mounted } from "../../test/dom";
import { ActivityGroup } from "./Activity";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}), parsePatchFiles: () => [] }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const approval = (id: string, requestId: number): Block => ({
  id,
  role: "approval",
  text: "Bash",
  approval: { requestId, name: "Bash", input: { command: "ls" } },
});
const question = (id: string, requestId: number): Block => ({
  id,
  role: "question",
  text: "Pick",
  question: {
    requestId,
    questions: [{ question: "Which?", header: "Which", multiSelect: false, options: [{ label: "A" }] }],
  },
});

let view: Mounted | null = null;
const onApprove = vi.fn<(requestId: number, decision: ApprovalDecision) => void>();
const onAnswer = vi.fn<(requestId: number, answers: Answers | null) => void>();

function render(blocks: Block[], live: boolean) {
  view = mount(
    <ActivityGroup blocks={blocks} live={live} focusId={null} marked={null} onApprove={onApprove} onAnswer={onAnswer} />,
  );
}

beforeEach(() => {
  onApprove.mockClear();
  onAnswer.mockClear();
});
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("which card takes the keys", () => {
  it("gives them to the newest open approval of the live group", () => {
    render([approval("a", 1), approval("b", 2)], true);
    press(document.body, "Enter");
    expect(onApprove.mock.calls).toEqual([[2, "allow"]]);
  });

  it("gives them to a question when it is the newest thing waiting", () => {
    render([approval("a", 1), question("q", 5)], true);
    press(document.body, "Escape");
    expect(onAnswer.mock.calls).toEqual([[5, null]]);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("gives them to nobody in a group the agent has moved on from", () => {
    render([approval("a", 1), question("q", 5)], false);
    press(document.body, "Enter");
    press(document.body, "Escape");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
