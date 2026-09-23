// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, Block } from "../../lib/blocks";
import { click, mount, press, type Mounted } from "../../test/dom";
import { ApprovalCard } from "./ApprovalCard";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});
vi.mock("@pierre/diffs", () => ({ parseDiffFromFile: () => ({}), parsePatchFiles: () => [] }));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const request = (requestId = 4): Block => ({
  id: "a1",
  role: "approval",
  text: "Run tests",
  approval: { requestId, name: "Bash", input: { command: "npm test" } },
});

let view: Mounted | null = null;
const onApprove = vi.fn<(requestId: number, decision: ApprovalDecision) => void>();

function render(block: Block, hot = true) {
  view = mount(<ApprovalCard block={block} hot={hot} onApprove={onApprove} />);
  return view.container;
}

function button(name: string): HTMLButtonElement {
  const found = [...view!.container.querySelectorAll("button")].find((el) => el.textContent === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
}

beforeEach(() => onApprove.mockClear());
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("buttons", () => {
  it.each([
    ["Allow", "allow"],
    ["Always allow", "always"],
    ["Deny", "deny"],
  ] as const)("%s responds with %s", (name, decision) => {
    render(request(), false);
    click(button(name));
    expect(onApprove).toHaveBeenCalledWith(4, decision);
  });
});

describe("keys", () => {
  it("allows on Enter and denies on Escape", () => {
    render(request());
    expect(press(document.body, "Enter")).toBe(true);
    expect(press(document.body, "Escape")).toBe(true);
    expect(onApprove.mock.calls).toEqual([
      [4, "allow"],
      [4, "deny"],
    ]);
  });

  it("leaves keys typed into a field and chords alone", () => {
    render(request());
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    expect(press(field, "Enter")).toBe(false);
    field.remove();
    expect(press(document.body, "Enter", { metaKey: true })).toBe(false);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("listens only while it is the newest open card", () => {
    render(request(), false);
    press(document.body, "Enter");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    render(request());
    view!.unmount();
    view = null;
    press(document.body, "Enter");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("takes focus when it becomes the card to answer", () => {
    const container = render(request(), false);
    view!.rerender(<ApprovalCard block={request()} hot onApprove={onApprove} />);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("does nothing without a request to answer", () => {
    render({ id: "a", role: "approval", text: "" });
    press(document.body, "Enter");
    expect(onApprove).not.toHaveBeenCalled();
  });
});
