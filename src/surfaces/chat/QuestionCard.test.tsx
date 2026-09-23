// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answers, Block, Question } from "../../lib/blocks";
import { click, mount, only, press, type, type Mounted } from "../../test/dom";
import { QuestionCard } from "./QuestionCard";

vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

const RUNTIME: Question = {
  question: "Which runtime?",
  header: "Runtime",
  multiSelect: false,
  options: [{ label: "Node", description: "LTS" }, { label: "Bun" }],
};
const CHECKS: Question = {
  question: "Which checks?",
  header: "Checks",
  multiSelect: true,
  options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }],
};

const ask = (...questions: Question[]): Block => ({
  id: "q1",
  role: "question",
  text: "Question",
  question: { requestId: 7, questions },
});

let view: Mounted | null = null;
const onAnswer = vi.fn<(requestId: number, answers: Answers | null) => void>();

function render(block: Block, hot = true) {
  view = mount(<QuestionCard block={block} hot={hot} onAnswer={onAnswer} />);
  return view.container;
}

function button(name: string): HTMLButtonElement {
  const found = [...view!.container.querySelectorAll("button")].filter((el) => el.textContent === name);
  if (found.length !== 1) throw new Error(`expected one ${name} button, found ${found.length}`);
  return found[0]!;
}

/** Radios take a click on their button. A checkbox takes it on its native input: under
 *  happy-dom a click on the painted box also reaches the wrapping label and toggles twice. */
const choices = (role: "radio" | "checkbox") =>
  [...view!.container.querySelectorAll<HTMLElement>(role === "radio" ? '[role="radio"]' : 'input[type="checkbox"]')];

beforeEach(() => onAnswer.mockClear());
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("answering with the mouse", () => {
  it("submits the chosen option", () => {
    render(ask(RUNTIME));
    expect(button("Submit").disabled).toBe(true);
    click(choices("radio")[1]!);
    click(button("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Bun" });
  });

  it("adds the typed answer to the choices", () => {
    render(ask(CHECKS));
    click(choices("checkbox")[0]!);
    click(choices("checkbox")[2]!);
    type(only<HTMLInputElement>(view!.container, "input.crew-field"), " and e2e ");
    click(button("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which checks?": "Lint, Tests, and e2e" });
  });

  it("takes a typed answer alone", () => {
    render(ask(RUNTIME));
    type(only<HTMLInputElement>(view!.container, "input.crew-field"), "Deno");
    click(button("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Deno" });
  });

  it("walks a set with Next and sends every answer at the end", () => {
    render(ask(RUNTIME, CHECKS));
    expect(button("Next").disabled).toBe(true);
    click(choices("radio")[0]!);
    click(button("Next"));
    click(choices("checkbox")[1]!);
    click(button("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Node", "Which checks?": "Types" });
  });

  it("jumps between questions from their headers and keeps the picks", () => {
    render(ask(RUNTIME, CHECKS));
    click(button("Checks"));
    click(choices("checkbox")[2]!);
    click(button("Runtime"));
    click(choices("radio")[1]!);
    click(button("Next"));
    click(button("Submit"));
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Bun", "Which checks?": "Tests" });
  });

  it("will not submit until every question is answered", () => {
    render(ask(RUNTIME, CHECKS));
    click(button("Checks"));
    click(choices("checkbox")[0]!);
    expect(button("Submit").disabled).toBe(true);
  });

  it("dismisses without answers", () => {
    render(ask(RUNTIME));
    click(button("Dismiss"));
    expect(onAnswer).toHaveBeenCalledWith(7, null);
  });
});

describe("answering with the keyboard", () => {
  it("picks by letter and submits on Enter", () => {
    render(ask(RUNTIME));
    expect(press(document.body, "b")).toBe(true);
    expect(press(document.body, "Enter")).toBe(true);
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Bun" });
  });

  it("toggles multi-select options by letter", () => {
    render(ask(CHECKS));
    press(document.body, "a");
    press(document.body, "c");
    press(document.body, "a");
    press(document.body, "Enter");
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which checks?": "Tests" });
  });

  it("advances through a set on Enter", () => {
    render(ask(RUNTIME, CHECKS));
    press(document.body, "a");
    press(document.body, "Enter");
    press(document.body, "b");
    press(document.body, "Enter");
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Node", "Which checks?": "Types" });
  });

  it("does nothing on Enter before an answer", () => {
    render(ask(RUNTIME));
    expect(press(document.body, "Enter")).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("dismisses on Escape", () => {
    render(ask(RUNTIME));
    press(document.body, "Escape");
    expect(onAnswer).toHaveBeenCalledWith(7, null);
  });

  it("treats letters typed in its field as text, and Enter there as submit", () => {
    render(ask(RUNTIME));
    const field = only<HTMLInputElement>(view!.container, "input.crew-field");
    expect(press(field, "b")).toBe(false);
    type(field, "Deno");
    press(field, "Enter");
    expect(onAnswer).toHaveBeenCalledWith(7, { "Which runtime?": "Deno" });
  });

  it("leaves Enter in the composer to the composer", () => {
    render(ask(RUNTIME));
    press(document.body, "a");
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    expect(press(composer, "Enter")).toBe(false);
    composer.remove();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("leaves chords to the app", () => {
    render(ask(RUNTIME));
    expect(press(document.body, "a", { metaKey: true })).toBe(false);
    press(document.body, "Escape", { ctrlKey: true });
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("listens only while it is the newest open card", () => {
    render(ask(RUNTIME), false);
    press(document.body, "a");
    press(document.body, "Escape");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    render(ask(RUNTIME));
    view!.unmount();
    view = null;
    press(document.body, "Escape");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe("focus", () => {
  it("takes focus from the composer when it becomes the card to answer", () => {
    const container = render(ask(RUNTIME), false);
    expect(document.activeElement).toBe(document.body);
    view!.rerender(<QuestionCard block={ask(RUNTIME)} hot onAnswer={onAnswer} />);
    expect(container.contains(document.activeElement)).toBe(true);
  });
});

describe("empty questions", () => {
  it("listens for nothing without a question to answer", () => {
    render({ id: "q", role: "question", text: "" });
    press(document.body, "Escape");
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
