import type { Answers, Question } from "./blocks";

export type Pick = { chosen: string[]; other: string };
export type Picks = Record<string, Pick>;

export const EMPTY_PICK: Pick = { chosen: [], other: "" };

const LETTERS = "ABCDEFGHIJ";

export function answered(pick: Pick | undefined): boolean {
  return pick !== undefined && (pick.chosen.length > 0 || pick.other.trim().length > 0);
}

export function allAnswered(questions: Question[], picks: Picks): boolean {
  return questions.every((q) => answered(picks[q.question]));
}

/** A multi-select toggles the option; a single choice replaces it. */
export function choose(pick: Pick, label: string, multiSelect: boolean): Pick {
  if (!multiSelect) return { ...pick, chosen: [label] };
  const chosen = pick.chosen.includes(label) ? pick.chosen.filter((item) => item !== label) : [...pick.chosen, label];
  return { ...pick, chosen };
}

/** What Claude Code expects back: each question's choices, then the typed answer, comma-joined. */
export function shapeAnswers(questions: Question[], picks: Picks): Answers {
  const answers: Answers = {};
  for (const q of questions) {
    const p = picks[q.question] ?? EMPTY_PICK;
    const parts = [...p.chosen];
    if (p.other.trim()) parts.push(p.other.trim());
    answers[q.question] = parts.join(", ");
  }
  return answers;
}

export function optionLetter(index: number): string {
  return LETTERS[index] ?? "·";
}

export type QuestionKey = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
};

export type QuestionKeyContext = {
  /** The key landed in a text field. */
  typing: boolean;
  /** That field is the card's own. */
  inCard: boolean;
  /** The current question already has an answer. */
  answered: boolean;
  options: number;
};

export type QuestionKeyAction = { kind: "dismiss" } | { kind: "advance" } | { kind: "choose"; index: number };

/**
 * Letters pick, Enter advances, Escape dismisses. Chords belong to the app, and
 * letters typed into a field are text, not answers.
 */
export function questionKey(event: QuestionKey, context: QuestionKeyContext): QuestionKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "Escape") return { kind: "dismiss" };
  if (event.key === "Enter" && !event.shiftKey) {
    if (context.typing && !context.inCard) return null;
    return context.answered ? { kind: "advance" } : null;
  }
  if (context.typing || event.key.length !== 1) return null;
  const index = LETTERS.indexOf(event.key.toUpperCase());
  return index >= 0 && index < context.options ? { kind: "choose", index } : null;
}
