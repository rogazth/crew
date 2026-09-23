/**
 * Key chords without React or the DOM, so the window and the main process read
 * them the same way. The window binds through @tanstack/react-hotkeys, but a
 * focused page swallows its keys, so the main process matches them here. The
 * rules mirror tanstack's matchesKeyboardEvent; a test holds the two together.
 */

export type ChordInput = { key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean };
export type ChordSpec =
  | string
  | { key: string; mod?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };

type Chord = {
  key: string;
  /** The key upper-cased and its physical code, worked out once instead of per key pressed. */
  upper: string;
  code: string | undefined;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

/** What a key event says about itself, read once however many chords it is checked against. */
type Pressed = {
  input: ChordInput;
  key: string;
  upper: string;
  dead: boolean;
  /** A one-character letter, and whether it is a plain a–z one. */
  letter: boolean;
  ascii: boolean;
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

const PUNCTUATION_CODES = new Map([
  ["[", "BracketLeft"],
  ["]", "BracketRight"],
  [",", "Comma"],
  [".", "Period"],
  ["/", "Slash"],
  [";", "Semicolon"],
  ["'", "Quote"],
  ["\\", "Backslash"],
  ["`", "Backquote"],
  ["-", "Minus"],
  ["=", "Equal"],
]);

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
    key,
    upper: key.toUpperCase(),
    code: codeOf(key.toUpperCase()),
    meta: flags.meta || (flags.mod && isMac),
    ctrl: flags.ctrl || (flags.mod && !isMac),
    alt: flags.alt,
    shift: flags.shift,
  };
}

function codeOf(key: string): string | undefined {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES.get(key);
}

function pressed(input: ChordInput): Pressed {
  const key = input.key === " " ? "Space" : input.key;
  const letter = key.length === 1 && /^\p{L}$/u.test(key);
  return { input, key, upper: key.toUpperCase(), dead: key === "Dead", letter, ascii: letter && /^[A-Za-z]$/.test(key) };
}

function keyMatches(chord: Chord, press: Pressed): boolean {
  if (!chord.key) return false;
  const single = press.key.length === 1 && chord.key.length === 1;
  if (single) {
    if (press.upper === chord.upper) return true;
    // A letter is the layout speaking: Dvorak's ⌘Y is ⌘Y wherever that key
    // sits. Only ⌥ turns a letter into another one (ˆ, å), and then the
    // physical key decides.
    if (press.letter && (press.ascii || !press.input.alt)) return false;
  }
  // ⇧ punctuation, ⌥ characters and dead keys: fall back to the physical key.
  if (press.input.code && (press.dead || single)) return chord.code === press.input.code;
  return press.upper === chord.upper;
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
export function matchChord(spec: ChordSpec, input: ChordInput, isMac: boolean): boolean {
  return matches(chordOf(spec, isMac), pressed(input));
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
 * What a key pressed inside a web page means to the app: the live command it
 * belongs to, or null to let the page have it. An auto-repeat of a command that
 * does not repeat is still claimed, so the page never sees half a chord, but it
 * does not run.
 */
export function resolveForward(
  input: ForwardInput,
  commands: readonly LiveCommand[],
  isMac: boolean,
): { id: string; run: boolean } | null {
  if (input.type !== "keyDown") return null;
  // ⌥ alone composes characters and bare keys type; only ⌘ and Ctrl chords are the app's.
  if (!input.meta && !input.ctrl) return null;
  const press = pressed(input);
  if (EDITING.some((spec) => matches(chordOf(spec, isMac), press))) return null;
  const command = commands.find((c) => matches(chordOf(c.keys, isMac), press));
  if (!command) return null;
  return { id: command.id, run: command.repeat || !input.isAutoRepeat };
}
