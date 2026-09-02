/** Parse and match `Mod+Shift+B` style bindings. `Mod` is Cmd on macOS, Ctrl elsewhere. */

export type Chord = {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
};

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export function parseBinding(binding: string): Chord {
  const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
  const chord: Chord = { mod: false, ctrl: false, shift: false, alt: false, key: "" };
  if (parts.length === 0) return chord;

  const key = parts.at(-1);
  chord.key = key?.toLowerCase() ?? "";

  for (const part of parts.slice(0, -1)) {
    switch (part.toLowerCase()) {
      case "mod":
      case "meta":
      case "cmd":
      case "command":
        chord.mod = true;
        break;
      case "ctrl":
      case "control":
        chord.ctrl = true;
        break;
      case "shift":
        chord.shift = true;
        break;
      case "alt":
      case "option":
        chord.alt = true;
        break;
    }
  }
  return chord;
}

export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  const chord = parseBinding(binding);
  if (!chord.key) return false;

  const hasMod = event.metaKey || event.ctrlKey;
  if (chord.mod) {
    if (!hasMod) return false;
  } else if (chord.ctrl) {
    if (!event.ctrlKey || event.metaKey) return false;
  } else if (hasMod) {
    return false;
  }

  if (event.shiftKey !== chord.shift) return false;
  if (event.altKey !== chord.alt) return false;

  // Shift rewrites `[` to `{`, and non-US layouts move the digits; punctuation and
  // digits match the physical key so ⇧⌘] lands where the browser puts it.
  const code = physicalCode(chord.key);
  if (code) return event.code === code;
  return event.key.toLowerCase() === chord.key;
}

const PHYSICAL: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

function physicalCode(key: string): string | null {
  if (key in PHYSICAL) return PHYSICAL[key] ?? null;
  if (key.length === 1 && key >= "0" && key <= "9") return `Digit${key}`;
  return null;
}

/** ⌘⌫ on macOS, Delete elsewhere: the platform's "remove the focused row" chord. */
export function isDeleteChord(event: { key: string; metaKey: boolean }): boolean {
  return IS_MAC ? event.key === "Backspace" && event.metaKey : event.key === "Delete";
}

/** Glyph string for chrome hints: `Mod+Shift+B` → `⌘⇧B` on Mac, `Ctrl+Shift+B` elsewhere. */
export function formatBinding(binding: string): string {
  const chord = parseBinding(binding);
  const key = displayKey(chord.key);
  if (IS_MAC) {
    // Apple's order: Control, Option, Shift, Command.
    return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (chord.mod || chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function displayKey(key: string): string {
  if (key === "enter" || key === "return") return "⏎";
  if (key === "escape" || key === "esc") return "Esc";
  if (key === "backspace") return "⌫";
  if (key === "tab") return "⇥";
  if (key.length === 1) return key.toUpperCase();
  return key;
}
