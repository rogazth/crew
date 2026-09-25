/**
 * Key chords without React or the DOM, so the window and the main process read
 * them the same way: the window matches its own keydowns here, and a focused
 * page swallows its keys, so the main process matches those here too.
 *
 * The rules are Orca's. The key a chord names is the key typed, not where it
 * sits: ⌘] is whatever key types ] or }, so on a Latin American Mac it is the
 * } key, and ⌘+ on the key a US board calls ] is not ⌘]. Braces are brackets,
 * as ⇧ makes them on a US board. Only when the event names no key (a dead key)
 * or ⌥ turned it into another character does the physical key decide, read
 * through the current layout when there is one.
 */

export type ChordInput = { key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };
export type ChordSpec =
  | string
  | { key: string; mod?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };

/** What each physical key types unmodified on the current layout, by `KeyboardEvent.code`. */
export type KeyboardLayout = Readonly<Record<string, string>>;

type Chord = {
  /** The key as a token (see `tokenOf`), worked out once instead of per key pressed. */
  token: string | null;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Written Mod+Alt: off macOS that is Ctrl+Alt, which AltGr sends too. */
  modAlt: boolean;
};

type Modifier = "mod" | "meta" | "ctrl" | "alt" | "shift";

const MODIFIERS = new Map<string, Modifier>([
  ["mod", "mod"],
  ["commandorcontrol", "mod"],
  ["meta", "meta"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
]);

const PUNCTUATION = new Map([
  ["[", "BRACKETLEFT"],
  ["{", "BRACKETLEFT"],
  ["]", "BRACKETRIGHT"],
  ["}", "BRACKETRIGHT"],
  ["-", "MINUS"],
  ["_", "UNDERSCORE"],
  ["=", "EQUAL"],
  ["+", "PLUS"],
  [",", "COMMA"],
  [".", "PERIOD"],
  ["/", "SLASH"],
  ["\\", "BACKSLASH"],
  [";", "SEMICOLON"],
  ["'", "QUOTE"],
  ["`", "BACKQUOTE"],
]);
const PUNCTUATION_TOKENS = new Set(PUNCTUATION.values());

/** ⇧ punctuation a US board types, read back as its key only while ⇧ is held. */
const SHIFTED = new Map([
  ["<", "COMMA"],
  [">", "PERIOD"],
  ["?", "SLASH"],
  ["|", "BACKSLASH"],
  [":", "SEMICOLON"],
  ['"', "QUOTE"],
  ["~", "BACKQUOTE"],
]);

/** Keys that say nothing about what was typed; only these send matching to the physical key. */
const UNNAMED = new Set(["", "Dead", "Unidentified"]);
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "OS", "Fn", "FnLock", "Hyper", "Super", "Symbol", "SymbolLock"]);

/** A key as matching compares it: A–Z, 0–9, a punctuation name, or a named key upper-cased; null for any other character. */
function tokenOf(key: string): string | null {
  if (key === " ") return "SPACE";
  if (key.length === 1) {
    if (/^[A-Za-z0-9]$/.test(key)) return key.toUpperCase();
    return PUNCTUATION.get(key) ?? null;
  }
  if (UNNAMED.has(key) || MODIFIER_KEYS.has(key)) return null;
  return key.toUpperCase();
}

/**
 * The main process matches every key pressed in a page against every live
 * command, so a spec is parsed once, not per key. Object specs are cached by
 * identity: the live list keeps the same objects until the window republishes.
 */
const parsedStrings = new Map<string, Chord>();
const parsedObjects = [new WeakMap<object, Chord>(), new WeakMap<object, Chord>()] as const;

function chordOf(spec: ChordSpec, isMac: boolean): Chord {
  if (typeof spec === "string") {
    const key = `${isMac ? "m" : "o"}${spec}`;
    let chord = parsedStrings.get(key);
    if (!chord) {
      chord = parse(spec, isMac);
      parsedStrings.set(key, chord);
    }
    return chord;
  }
  const cache = parsedObjects[isMac ? 0 : 1];
  let chord = cache.get(spec);
  if (!chord) {
    chord = parse(spec, isMac);
    cache.set(spec, chord);
  }
  return chord;
}

function parse(spec: ChordSpec, isMac: boolean): Chord {
  const flags = { mod: false, meta: false, ctrl: false, alt: false, shift: false };
  let key: string;
  if (typeof spec === "string") {
    const parts = spec.split("+");
    key = parts.pop()?.trim() ?? "";
    for (const part of parts) {
      const modifier = MODIFIERS.get(part.trim().toLowerCase());
      if (modifier) flags[modifier] = true;
    }
  } else {
    // The main process gets these over IPC; a malformed one must not throw on every key.
    key = typeof spec.key === "string" ? spec.key : "";
    flags.mod = spec.mod ?? false;
    flags.meta = spec.meta ?? false;
    flags.ctrl = spec.ctrl ?? false;
    flags.alt = spec.alt ?? false;
    flags.shift = spec.shift ?? false;
  }
  return {
    token: tokenOf(key),
    meta: flags.meta || (flags.mod && isMac),
    ctrl: flags.ctrl || (flags.mod && !isMac),
    alt: flags.alt,
    shift: flags.shift,
    modAlt: flags.mod && flags.alt,
  };
}

/** What a key event says about itself, read once however many chords it is checked against. */
type Pressed = {
  input: ChordInput;
  /** The key typed, as a token, or null when the event does not name one. */
  logical: string | null;
  /** The event names no key at all, so only its physical key can say which it is. */
  unnamed: boolean;
  /** A non-Latin character under Ctrl or ⌘ off macOS: the physical key is the only Latin reading. */
  nonLatin: boolean;
  isMac: boolean;
  layout: KeyboardLayout | undefined;
};

function pressed(input: ChordInput, isMac: boolean, layout: KeyboardLayout | undefined): Pressed {
  const key = input.key ?? "";
  let logical = MODIFIER_KEYS.has(key) ? null : tokenOf(key);
  if (logical === null && input.shift) logical = SHIFTED.get(key) ?? null;
  const nonLatin =
    !isMac &&
    (input.ctrl || input.meta) &&
    // AltGr arrives as Ctrl+Alt; that is text, not a chord.
    !(input.ctrl && input.alt) &&
    logical === null &&
    key !== "" &&
    !UNNAMED.has(key) &&
    !MODIFIER_KEYS.has(key);
  return { input, logical, unnamed: UNNAMED.has(key), nonLatin, isMac, layout };
}

/** The physical key by the name a US board gives it: KeyA is A, BracketRight is BRACKETRIGHT. */
function usToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code ? code.toUpperCase() : null;
}

/**
 * The physical key by what it types on the current layout, so ⌘⌥ on the key
 * that types } is ⌘⌥], wherever the layout puts it. Without a layout, or for a
 * key it does not list, the US name.
 */
function physicalToken(press: Pressed): string | null {
  const code = press.input.code ?? "";
  const typed = press.layout?.[code];
  if (typed !== undefined) return tokenOf(typed);
  return usToken(code);
}

function keyMatches(chord: Chord, press: Pressed): boolean {
  const token = chord.token;
  if (token === null) return false;
  const { input } = press;
  // Off macOS, AltGr is Ctrl+Alt: international text, not a Mod+Alt chord.
  if (
    !press.isMac &&
    chord.modAlt &&
    PUNCTUATION_TOKENS.has(token) &&
    input.ctrl &&
    input.alt &&
    !input.meta &&
    !PUNCTUATION_TOKENS.has(usToken(input.code ?? "") ?? "")
  ) {
    return false;
  }
  if (press.logical !== null) return press.logical === token;
  // ⌥ on macOS composes another character (⌥I is ˆ), leaving no key named; a chord with ⌥ reads the key under it.
  const option = press.isMac && chord.alt && input.alt;
  if (press.unnamed || option) return physicalToken(press) === token;
  if (press.nonLatin) return usToken(input.code ?? "") === token;
  return false;
}

function matches(chord: Chord, press: Pressed): boolean {
  const { input } = press;
  return (
    input.meta === chord.meta &&
    input.ctrl === chord.ctrl &&
    input.alt === chord.alt &&
    input.shift === chord.shift &&
    keyMatches(chord, press)
  );
}

/** Whether a key event is this chord. `Mod` is ⌘ on macOS and Ctrl elsewhere; modifiers must match exactly. */
export function matchChord(spec: ChordSpec, input: ChordInput, isMac: boolean, layout?: KeyboardLayout): boolean {
  return matches(chordOf(spec, isMac), pressed(input, isMac, layout));
}

/** A command the window can run right now, as it publishes them to the main process. */
export type LiveCommand = { id: string; keys: ChordSpec; repeat: boolean };
export type ForwardInput = ChordInput & { type: string; isAutoRepeat: boolean };

/**
 * Copy, paste, cut, select all, undo and redo belong to the page and the Edit
 * menu's roles. Forwarding one would break editing in every page, so no
 * binding can claim them.
 */
const EDITING: readonly ChordSpec[] = ["Mod+C", "Mod+V", "Mod+X", "Mod+A", "Mod+Z", "Mod+Shift+Z"];

/**
 * What a key pressed means to the app: the live command it belongs to, or null
 * to let the page or the focused field have it. An auto-repeat of a command
 * that does not repeat is still claimed, so the page never sees half a chord,
 * but it does not run.
 */
export function resolveForward(
  input: ForwardInput,
  commands: readonly LiveCommand[],
  isMac: boolean,
  layout?: KeyboardLayout,
): { id: string; run: boolean } | null {
  if (input.type !== "keyDown") return null;
  // ⌥ alone composes characters and bare keys type; only ⌘ and Ctrl chords are the app's.
  if (!input.meta && !input.ctrl) return null;
  const press = pressed(input, isMac, layout);
  if (EDITING.some((spec) => matches(chordOf(spec, isMac), press))) return null;
  const command = commands.find((c) => matches(chordOf(c.keys, isMac), press));
  if (!command) return null;
  return { id: command.id, run: command.repeat || !input.isAutoRepeat };
}
