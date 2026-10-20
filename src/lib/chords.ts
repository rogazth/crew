/**
 * A chord as it is stored and exchanged: "Mod+Shift+K". `Mod` is ⌘ on macOS and
 * Ctrl elsewhere; Ctrl, Alt, Shift and Meta are the keys themselves. The key is
 * the last part and may be "+", so a chord is read from the front, never split.
 */

export type ParsedChord = { key: string; mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

const NAMED = ["Enter", "Tab", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
const NAMED_BY_LOWER = new Map(NAMED.map((name) => [name.toLowerCase(), name]));
const PUNCTUATION = "[]-=+,./\\;'`";
const BRACES = new Map([
  ["{", "["],
  ["}", "]"],
]);
const MODIFIERS = new Map<string, "mod" | "ctrl" | "alt" | "shift" | "meta">([
  ["mod", "mod"],
  ["commandorcontrol", "mod"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
  ["meta", "meta"],
  ["cmd", "meta"],
  ["command", "meta"],
]);

/** The key of a chord as stored: a letter upper-cased, a brace its bracket, a named key spelled out; null for anything else. */
export function normalizeKey(raw: string): string | null {
  const key = BRACES.get(raw) ?? raw;
  if (key.length === 1) {
    if (/^[A-Za-z0-9]$/.test(key)) return key.toUpperCase();
    return PUNCTUATION.includes(key) ? key : null;
  }
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return NAMED_BY_LOWER.get(key.toLowerCase()) ?? null;
}

const isFunctionKey = (key: string) => /^F\d+$/.test(key);

function build(flags: Omit<ParsedChord, "key">, key: string): ParsedChord | null {
  const normal = normalizeKey(key);
  return normal ? { key: normal, ...flags } : null;
}

function read(text: string): ParsedChord | null {
  let rest = text.trim();
  const flags = { mod: false, ctrl: false, alt: false, shift: false, meta: false };
  for (;;) {
    const match = /^([A-Za-z]+)\+(?=.)/.exec(rest);
    const modifier = match && MODIFIERS.get(match[1]!.toLowerCase());
    if (!match || !modifier) break;
    flags[modifier] = true;
    rest = rest.slice(match[0].length);
  }
  return build(flags, rest);
}

/** A stored chord, or null when it is not one. A chord needs ⌘, ⌃ or ⌥ unless it is a function key. */
export function parseChord(text: unknown): ParsedChord | null {
  const chord = typeof text === "string" ? read(text) : null;
  if (!chord) return null;
  if (!(chord.mod || chord.ctrl || chord.alt || chord.meta) && !isFunctionKey(chord.key)) return null;
  return chord;
}

/** The canonical text of a chord: modifiers in one order, then the key. */
export function formatChord(chord: ParsedChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("Mod");
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Meta");
  return [...parts, chord.key].join("+");
}

/** The canonical text of any chord the keymap accepts (a string or an object), or null. Defaults need not follow the page's rules. */
export function canonicalOf(spec: string | { key: string; mod?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }): string | null {
  const chord =
    typeof spec === "string"
      ? read(spec)
      : build({ mod: !!spec.mod, ctrl: !!spec.ctrl, alt: !!spec.alt, shift: !!spec.shift, meta: !!spec.meta }, spec.key);
  return chord ? formatChord(chord) : null;
}

/** The object form the keymap and the hotkey formatter take. */
export function toHotkey(chord: ParsedChord) {
  return {
    key: chord.key,
    ...(chord.mod && { mod: true }),
    ...(chord.ctrl && { ctrl: true }),
    ...(chord.alt && { alt: true }),
    ...(chord.shift && { shift: true }),
    ...(chord.meta && { meta: true }),
  };
}

const CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Enter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

export type KeyPress = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/** The key a press names: letters and digits by position, punctuation by what it types (⌥ rewrites that, so then by position). */
export function keyOfPress(press: Pick<KeyPress, "key" | "code" | "altKey">): string | null {
  const letter = /^Key([A-Z])$/.exec(press.code);
  if (letter) return letter[1]!;
  const digit = /^Digit(\d)$/.exec(press.code);
  if (digit) return digit[1]!;
  if (/^F\d{1,2}$/.test(press.code)) return normalizeKey(press.code);
  if (!press.altKey && press.key.length === 1) {
    const typed = normalizeKey(press.key);
    if (typed && PUNCTUATION.includes(typed)) return typed;
  }
  return CODES[press.code] ?? null;
}

/** The chord a key press makes, as stored; null while only modifiers are down. */
export function chordFromPress(press: KeyPress, isMac: boolean): string | null {
  const key = keyOfPress(press);
  if (!key) return null;
  const chord: ParsedChord = {
    key,
    mod: isMac ? press.metaKey : press.ctrlKey,
    ctrl: isMac ? press.ctrlKey : false,
    alt: press.altKey,
    shift: press.shiftKey,
    meta: isMac ? false : press.metaKey,
  };
  return formatChord(chord);
}

/** What a chord is on this platform, for telling two spellings of one chord apart: Mod is ⌘ on macOS and Ctrl elsewhere. */
export function sameKeyOf(spec: string | Parameters<typeof canonicalOf>[0], isMac: boolean): string | null {
  const chord = typeof spec === "string" ? read(spec) : read(canonicalOf(spec) ?? "");
  if (!chord) return null;
  return formatChord({
    key: chord.key,
    mod: false,
    ctrl: chord.ctrl || (chord.mod && !isMac),
    alt: chord.alt,
    shift: chord.shift,
    meta: chord.meta || (chord.mod && isMac),
  });
}
