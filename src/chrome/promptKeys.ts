import { IS_MAC, isAltLetter } from "../lib/hotkey";
import type { PromptHandle } from "../surfaces/chat/PromptEditor";

/**
 * The prompt's picker keys: ⌥P the model, ⌥W the worktree. A picker takes the
 * keyboard when it opens, so the composer it came from stops hearing them; the
 * composer the keyboard was last in stays the one that answers, and an open
 * picker hands the key over: its own letter closes it, another's switches.
 * With the focus outside any field, the composer on screen answers them too,
 * and takes whatever is typed.
 */
export type PromptLetter = "P" | "W";
const LETTERS: PromptLetter[] = ["P", "W"];

type KeyEvent = { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

export function promptLetter(event: KeyEvent): PromptLetter | null {
  return LETTERS.find((letter) => isAltLetter(event, letter)) ?? null;
}

/** What a prompt can open with the picker keys. */
export type PromptPickers = { has: (letter: PromptLetter) => boolean; open: (letter: PromptLetter) => void };

/** A composer: what it opens, the element that says whether it is on screen, and its field. */
export type Prompt = {
  pickers: PromptPickers;
  element: () => HTMLElement | null;
  field: () => PromptHandle | null;
  /** ⇧Tab: the next effort level; false when this prompt has none to step. */
  stepEffort: () => boolean;
};

const prompts = new Set<Prompt>();
let active: Prompt | null = null;

const onScreen = (prompt: Prompt) => {
  const el = prompt.element();
  return !!el && !el.closest("[aria-hidden='true'], [inert]") && el.checkVisibility({ checkVisibilityCSS: true });
};

/** The composer the keys go to: the one the keyboard was last in, else the first on screen (other tabs' stay mounted). */
function current(): Prompt | null {
  if (active && onScreen(active)) return active;
  for (const prompt of prompts) if (onScreen(prompt)) return prompt;
  return null;
}

/** Where a key belongs to what has the focus: a field, or a list that reads letters as it is typed. */
const OWN_KEYS = "input, textarea, select, [contenteditable], [role='menu'], [role='listbox'], [role='dialog'], [role='alertdialog'], [role='tree'], [role='grid']";

/** What the keyboard walks with Tab. */
const CONTROLS = "a[href], button, summary, [role='button'], [role='tab'], [role='link'], [tabindex]:not([tabindex='-1'])";

/**
 * Focus anywhere but a field (a click on the chat, the sidebar, a chip): the
 * picker keys still reach the composer on screen, and typing goes to it. A
 * field of someone else's (a terminal, the palette, a form) keeps its keys, and
 * a key something already used (a card's letter, the sidebar's /) is left alone.
 */
function onWindowKey(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(OWN_KEYS)) return;
  const letter = promptLetter(event);
  if (letter) {
    const prompt = current();
    if (!prompt?.pickers.has(letter)) return;
    event.preventDefault();
    prompt.pickers.open(letter);
    return;
  }
  if (event.key === "Tab" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // On a control, ⇧Tab walks the focus back as it does everywhere; from nowhere in particular it is the prompt's.
    if (target?.closest(CONTROLS)) return;
    if (current()?.stepEffort()) event.preventDefault();
    return;
  }
  if (!typed(event, target) || claimed(event.key)) return;
  const field = current()?.field();
  if (!field) return;
  // A dead key only moves the focus: its accent waits for the next key, which lands in the field.
  if (event.key === "Dead") return field.focus();
  // The editor does not take a key that arrives as it gains the focus, so the character is written into it.
  event.preventDefault();
  const { from, to } = field.read();
  const at = from + event.key.length;
  field.apply({ start: from, end: to, insert: event.key, selStart: at, selEnd: at });
  field.focus();
}

/** A bare key something on screen answers (`data-keys`: the work sheet's x, a thread's): it is not typing. */
function claimed(key: string): boolean {
  return [...document.querySelectorAll<HTMLElement>("[data-keys]")].some(
    (el) => el.dataset.keys!.split(" ").includes(key) && el.checkVisibility(),
  );
}

/**
 * A key that writes: a character or a dead key's accent. ⌥ writes too, where
 * a layout puts @ or # under it, and so does AltGr off macOS, which is
 * Ctrl+Alt; ⌘ or Ctrl alone is a shortcut. Space on a button presses the button.
 */
function typed(event: KeyboardEvent, target: Element | null): boolean {
  if (event.metaKey || (event.ctrlKey && (IS_MAC || !event.altKey))) return false;
  if (event.key !== "Dead" && [...event.key].length !== 1) return false;
  return event.key !== " " || target === null || target === document.body;
}

/** A composer mounts; the returned function is its unmount. */
export function registerPrompt(prompt: Prompt): () => void {
  if (prompts.size === 0) window.addEventListener("keydown", onWindowKey);
  prompts.add(prompt);
  return () => {
    prompts.delete(prompt);
    if (active === prompt) active = null;
    if (prompts.size === 0) window.removeEventListener("keydown", onWindowKey);
  };
}

/** The composer the keyboard is in now; it answers the picker keys until another takes over. */
export function activatePrompt(prompt: Prompt) {
  active = prompt;
}

/**
 * In an open picker (`own` its letter, null for one without): its own letter
 * closes it, and another picker's letter swaps it for that one, opened once
 * this one has handed the focus back.
 */
export function pickerKeyDown(
  event: KeyEvent & { preventDefault: () => void; stopPropagation: () => void },
  own: PromptLetter | null,
  close: () => void,
): boolean {
  const letter = promptLetter(event);
  const pickers = current()?.pickers;
  if (!letter || (letter !== own && !pickers?.has(letter))) return false;
  event.preventDefault();
  event.stopPropagation();
  close();
  if (letter !== own && pickers) afterFocusReturns(() => pickers.open(letter));
  return true;
}

/**
 * A closing popup hands the focus back to where it was once its exit is over;
 * opening the next one before that would have its field robbed. A popup that
 * hands nothing back is waited for no longer than its exit takes.
 */
function afterFocusReturns(then: () => void) {
  const go = () => {
    clearTimeout(fallback);
    document.removeEventListener("focusin", go);
    requestAnimationFrame(then);
  };
  const fallback = setTimeout(go, 250);
  document.addEventListener("focusin", go);
}
