/**
 * What a key chord means inside the terminal, before xterm sees it. R2's map:
 * ⌘ chords spell the readline line-editing keys so the terminal edits like a
 * native macOS text field, ⌥ arrows and ⌥B/F/D move by word, and every other
 * ⌘ chord belongs to the app. Everything else is xterm's.
 */
export type TerminalKey =
  | { type: "input"; data: string }
  | { type: "scroll"; to: "top" | "bottom" }
  | { type: "select-all" }
  | { type: "app" }
  | { type: "xterm" };

type Key = {
  type: string;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const INPUT = (data: string): TerminalKey => ({ type: "input", data });
const APP: TerminalKey = { type: "app" };
const XTERM: TerminalKey = { type: "xterm" };

export function resolveTerminalKey(
  event: Key,
  {
    isMac,
    hasSelection,
    kittyKeyboard = false,
  }: { isMac: boolean; hasSelection: boolean; kittyKeyboard?: boolean },
): TerminalKey {
  const { metaKey, ctrlKey, altKey, shiftKey, key, code } = event;

  if (isMac && metaKey) {
    // keyup of a ⌘ chord must not reach xterm either, or it types the bare key.
    if (event.type !== "keydown" || ctrlKey || altKey || shiftKey) return APP;
    switch (key) {
      case "a":
        return { type: "select-all" };
      // ⌘C over nothing is the interrupt, as in R2; over a selection it copies.
      case "c":
        return hasSelection ? APP : INPUT("\x03");
      case "Backspace":
        return INPUT("\x15");
      case "Delete":
        return INPUT("\x0b");
      case "ArrowLeft":
        return INPUT("\x01");
      case "ArrowRight":
        return INPUT("\x05");
      case "ArrowUp":
        return { type: "scroll", to: "top" };
      case "ArrowDown":
        return { type: "scroll", to: "bottom" };
      default:
        return APP;
    }
  }

  if (event.type !== "keydown") return XTERM;

  // With the kitty protocol on, xterm encodes ⇧⏎ as `CSI 13;2u` itself.
  if (shiftKey && !metaKey && !ctrlKey && !altKey && key === "Enter") {
    return kittyKeyboard ? XTERM : INPUT("\x1b\r");
  }
  if (ctrlKey && !metaKey && !altKey && !shiftKey && key === "Backspace") return INPUT("\x17");

  if (altKey && !metaKey && !ctrlKey && !shiftKey) {
    switch (key) {
      case "Backspace":
        return INPUT("\x1b\x7f");
      case "Delete":
        return INPUT("\x1bd");
      case "ArrowLeft":
        return INPUT("\x1bb");
      case "ArrowRight":
        return INPUT("\x1bf");
    }
    // Option stays the compose key for accents, so these three readline words
    // are the only letters it claims.
    if (isMac && code === "KeyB") return INPUT("\x1bb");
    if (isMac && code === "KeyF") return INPUT("\x1bf");
    if (isMac && code === "KeyD") return INPUT("\x1bd");
  }

  return XTERM;
}
