import type { Answers, ApprovalDecision } from "./blocks";
import type { Question } from "./protocol";
import { quotePath } from "./terminalPaths";

/**
 * The chat talks to a session's CLI the way a person at its terminal would: by
 * typing. Every key and every pause lives here, per provider, as measured
 * against Claude Code 2.1.283 and Codex 0.154.0.
 */

/** One write to the terminal, `wait` ms after the one before it. */
export type Keystroke = { data: string; wait: number };

const CLEAR_LINE = "\x15";
const ENTER = "\r";
const ESC = "\x1b";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** An Enter written with the paste is taken as part of it; it goes on its own, this much later. */
export const ENTER_AFTER_MS = 500;
/** A pasted image path is turned into an attachment before the text may follow. */
export const PATH_SETTLE_MS = 300;
/** Codex opens its command menu only for a slash command typed a key at a time. */
export const SLASH_KEY_MS = 16;
/** A question card's answer is a walk through the CLI's form, one screen per key. */
export const ANSWER_STEP_MS = 1000;

const paste = (text: string) => `${PASTE_START}${text}${PASTE_END}`;

/**
 * What the chat's composer sends: the CLI's line cleared of anything typed in
 * the terminal, the attachments pasted as paths, the text, and Enter apart.
 * The text goes in as a paste even on one line: typed that fast, Claude 2.1.284
 * takes a file name in it for one to complete, and the Enter that follows
 * picks the completion instead of sending (every other message, measured).
 */
export function messageKeys(provider: string, text: string, paths: readonly string[] = []): Keystroke[] {
  const keys: Keystroke[] = [{ data: CLEAR_LINE, wait: 0 }];
  for (const path of paths) keys.push({ data: paste(`${quotePath(path)} `), wait: 0 });
  const settle = paths.length > 0 ? PATH_SETTLE_MS : 0;
  if (provider === "codex" && /^\/\S*( |$)/.test(text) && !text.includes("\n")) {
    [...text].forEach((key, at) => keys.push({ data: key, wait: at === 0 ? settle : SLASH_KEY_MS }));
  } else if (text) {
    keys.push({ data: paste(text), wait: settle });
  }
  keys.push({ data: ENTER, wait: ENTER_AFTER_MS });
  return keys;
}

/** Stop: what Esc does at the CLI's own prompt. */
export const STOP_KEYS: Keystroke[] = [{ data: ESC, wait: 0 }];

/** Claude's permission prompt: 1 Yes, 2 Yes and don't ask again, Esc No. */
export function approvalKeys(decision: ApprovalDecision): Keystroke[] {
  const data = decision === "allow" ? "1" : decision === "always" ? "2" : ESC;
  return [{ data, wait: 0 }];
}

/** Claude's folder trust prompt: "No, exit" is picked; ↓ moves to "Yes, I trust this folder". */
export function trustKeys(trust: boolean): Keystroke[] {
  return trust
    ? [
        { data: DOWN, wait: 0 },
        { data: ENTER, wait: ANSWER_STEP_MS / 2 },
      ]
    : [{ data: ESC, wait: 0 }];
}

/**
 * Claude's question form, answered. A digit picks an option and moves on; a
 * multi-select toggles its digits and → moves on; "Type something" is the row
 * after the options, then the text and Enter. Several questions, or a
 * multi-select, end on a review screen whose first option submits. `null`
 * dismisses the form.
 */
export function questionKeys(questions: readonly Question[], answers: Answers | null): Keystroke[] {
  if (answers === null) return [{ data: ESC, wait: 0 }];
  const keys: string[] = [];
  for (const question of questions) {
    const answer = answers[question.question] ?? "";
    const labels = question.options.map((option) => option.label);
    const picked = question.multiSelect ? answer.split(", ").filter(Boolean) : [answer];
    const custom = picked.filter((label) => !labels.includes(label)).join(", ");
    for (const label of picked) {
      const at = labels.indexOf(label);
      if (at >= 0) keys.push(String(at + 1));
    }
    if (custom) keys.push(String(labels.length + 1), custom, ENTER);
    if (question.multiSelect) keys.push(RIGHT);
  }
  if (questions.length > 1 || questions.some((question) => question.multiSelect)) keys.push("1");
  return keys.map((data, at) => ({ data, wait: at === 0 ? 0 : ANSWER_STEP_MS }));
}

export type SendClock = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_CLOCK: SendClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type Sending = {
  /** True once every key was written; false when it was cancelled or a write failed. */
  done: Promise<boolean>;
  cancel: () => void;
};

/**
 * One terminal's keys, one send at a time: the next waits for the Enter of the
 * one before, or the CLI would read the two as one line. A send cancelled
 * after its text landed clears the line again.
 */
export class PtyQueue {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly write: (data: string) => Promise<void>,
    private readonly clock: SendClock = REAL_CLOCK,
  ) {}

  send(keys: readonly Keystroke[]): Sending {
    let cancelled = false;
    let wake: (() => void) | null = null;
    let timer: unknown = null;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        if (ms <= 0) return resolve();
        wake = resolve;
        timer = this.clock.setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
      });

    const run = async (): Promise<boolean> => {
      let typed = false;
      for (const key of keys) {
        await pause(key.wait);
        if (cancelled) break;
        try {
          await this.write(key.data);
        } catch {
          return false;
        }
        if (key.data !== CLEAR_LINE) typed = true;
      }
      if (!cancelled) return true;
      if (typed) await this.write(CLEAR_LINE).catch(() => {});
      return false;
    };

    const done = this.tail.then(run, run);
    this.tail = done;
    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (timer !== null) this.clock.clearTimeout(timer);
        const resolve = wake as (() => void) | null;
        wake = null;
        resolve?.();
      },
    };
  }
}

const queues = new Map<string, PtyQueue>();

/** The queue of the terminal `id` writes to; one per terminal, for as long as the window lives. */
export function ptyQueue(id: string, write: (data: string) => Promise<void>): PtyQueue {
  let queue = queues.get(id);
  if (!queue) {
    queue = new PtyQueue(write);
    queues.set(id, queue);
  }
  return queue;
}
