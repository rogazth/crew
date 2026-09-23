import { describe, expect, it } from "vitest";
import type { Question } from "./blocks";
import {
  EMPTY_PICK,
  allAnswered,
  answered,
  choose,
  optionLetter,
  questionKey,
  shapeAnswers,
  type QuestionKeyContext,
} from "./question";

const SINGLE: Question = {
  question: "Which runtime?",
  header: "Runtime",
  multiSelect: false,
  options: [{ label: "Node" }, { label: "Bun" }],
};
const MULTI: Question = {
  question: "Which checks?",
  header: "Checks",
  multiSelect: true,
  options: [{ label: "Lint" }, { label: "Types" }, { label: "Tests" }],
};

const press = (key: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});
const idle: QuestionKeyContext = { typing: false, inCard: false, answered: false, options: 3 };

describe("answered", () => {
  it("counts a choice or typed text, not whitespace", () => {
    expect(answered(undefined)).toBe(false);
    expect(answered(EMPTY_PICK)).toBe(false);
    expect(answered({ chosen: [], other: "   " })).toBe(false);
    expect(answered({ chosen: ["Node"], other: "" })).toBe(true);
    expect(answered({ chosen: [], other: "Deno" })).toBe(true);
  });

  it("is complete only when every question has an answer", () => {
    const picks = { [SINGLE.question]: { chosen: ["Node"], other: "" } };
    expect(allAnswered([SINGLE, MULTI], picks)).toBe(false);
    expect(allAnswered([SINGLE], picks)).toBe(true);
    expect(allAnswered([], {})).toBe(true);
  });
});

describe("choose", () => {
  it("replaces a single choice and keeps the typed text", () => {
    const first = choose({ chosen: [], other: "note" }, "Node", false);
    expect(choose(first, "Bun", false)).toEqual({ chosen: ["Bun"], other: "note" });
  });

  it("toggles a multi-select option in pick order", () => {
    let pick = choose(EMPTY_PICK, "Types", true);
    pick = choose(pick, "Lint", true);
    expect(pick.chosen).toEqual(["Types", "Lint"]);
    expect(choose(pick, "Types", true).chosen).toEqual(["Lint"]);
    expect(EMPTY_PICK.chosen).toEqual([]);
  });
});

describe("shapeAnswers", () => {
  it("joins choices and the trimmed typed answer per question", () => {
    const answers = shapeAnswers([SINGLE, MULTI], {
      [SINGLE.question]: { chosen: ["Bun"], other: "" },
      [MULTI.question]: { chosen: ["Lint", "Tests"], other: "  e2e too " },
    });
    expect(answers).toEqual({ "Which runtime?": "Bun", "Which checks?": "Lint, Tests, e2e too" });
  });

  it("sends an empty string for a question nobody picked", () => {
    expect(shapeAnswers([SINGLE], {})).toEqual({ "Which runtime?": "" });
  });
});

describe("optionLetter", () => {
  it("letters the first ten options and dots the rest", () => {
    expect(optionLetter(0)).toBe("A");
    expect(optionLetter(9)).toBe("J");
    expect(optionLetter(10)).toBe("·");
  });
});

describe("questionKey", () => {
  it("leaves chords to the app", () => {
    expect(questionKey(press("Escape", { metaKey: true }), idle)).toBeNull();
    expect(questionKey(press("a", { ctrlKey: true }), idle)).toBeNull();
    expect(questionKey(press("Enter", { altKey: true }), { ...idle, answered: true })).toBeNull();
  });

  it("dismisses on Escape, even from a field", () => {
    expect(questionKey(press("Escape"), idle)).toEqual({ kind: "dismiss" });
    expect(questionKey(press("Escape"), { ...idle, typing: true })).toEqual({ kind: "dismiss" });
  });

  it("advances on Enter once the question is answered", () => {
    expect(questionKey(press("Enter"), idle)).toBeNull();
    expect(questionKey(press("Enter"), { ...idle, answered: true })).toEqual({ kind: "advance" });
    expect(questionKey(press("Enter", { shiftKey: true }), { ...idle, answered: true })).toBeNull();
  });

  it("takes Enter from the card's own field but not from the composer", () => {
    const typed = { ...idle, answered: true, typing: true };
    expect(questionKey(press("Enter"), { ...typed, inCard: true })).toEqual({ kind: "advance" });
    expect(questionKey(press("Enter"), typed)).toBeNull();
  });

  it("picks an option by letter, either case", () => {
    expect(questionKey(press("a"), idle)).toEqual({ kind: "choose", index: 0 });
    expect(questionKey(press("C"), idle)).toEqual({ kind: "choose", index: 2 });
  });

  it("ignores letters past the options, named keys and typing", () => {
    expect(questionKey(press("d"), idle)).toBeNull();
    expect(questionKey(press("z"), idle)).toBeNull();
    expect(questionKey(press("ArrowDown"), idle)).toBeNull();
    expect(questionKey(press("a"), { ...idle, typing: true })).toBeNull();
  });
});
