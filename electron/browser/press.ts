/**
 * What `browser_press` and `browser_type` send to a page.
 *
 * Not CDP key events: a guest only takes keyboard input while its <webview>
 * holds the window's focus, and giving it focus would take the keyboard from
 * the person using Crew (tried: `Input.dispatchKeyEvent` and `Input.insertText`
 * into an unfocused guest go nowhere, and can wedge its next screenshot). So
 * keys are played inside the page: the key events a script listens for, and
 * what the key does by default (editing commands, submitting a form, moving
 * focus, scrolling), which is what the page would have done with a real one.
 *
 * The grammar is pure and tested here; `STROKES_SCRIPT` runs in the page.
 */

const MODIFIER_NAMES: Record<string, "alt" | "ctrl" | "meta" | "shift"> = {
  alt: "alt",
  option: "alt",
  opt: "alt",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  shift: "shift",
};

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let n = 1; n <= 12; n++) NAMED[`f${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
};

/** The editing shortcuts, as the commands they run: ⌘ on macOS, Ctrl elsewhere. */
const SHORTCUTS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
  "shift+z": "redo",
  y: "redo",
};

/** One key press as the page sees it. */
export type Stroke = {
  key: string;
  code: string;
  keyCode: number;
  /** What it types, if anything. */
  text?: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** An editing command the shortcut runs instead of typing. */
  command?: string;
};

/** One printable character, or a named key, as the page's KeyboardEvent would see it. */
function keyDef(name: string): KeyDef | null {
  const named = NAMED[name.toLowerCase()];
  if (named) return named;
  if ([...name].length !== 1) return null;
  if (/^[a-z]$/i.test(name)) {
    return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name };
  }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name };
  const punct = PUNCTUATION[name];
  if (punct) return { key: name, code: punct.code, keyCode: punct.keyCode, text: name };
  // Anything else types as itself; the page sees the character, which is what text input reads.
  return { key: name, code: "", keyCode: 0, text: name };
}

/**
 * "Enter", "Meta+A", "Control+Shift+K", "Shift+Tab": modifiers first, the
 * key last, joined by "+". A "+" key is typed with browser_type.
 */
export function parseChord(chord: string, isMac: boolean): Stroke {
  const parts = chord.split("+").map((part) => part.trim());
  const keyName = parts.pop() ?? "";
  if (!keyName) throw new Error(`"${chord}" names no key. Try Enter, Tab, Escape, ArrowDown or Meta+A.`);
  const held = { alt: false, ctrl: false, meta: false, shift: false };
  for (const part of parts) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (!modifier) throw new Error(`"${part}" is not a modifier. Use Meta, Control, Alt or Shift.`);
    held[modifier] = true;
  }
  const def = keyDef(keyName);
  if (!def) throw new Error(`"${keyName}" is not a key. Try Enter, Tab, Escape, Backspace, ArrowDown, a letter or F1-F12.`);
  // With ⌘ or Ctrl held a letter is a shortcut, not text.
  const typing = def.text !== undefined && !held.ctrl && !held.meta;
  const shifted = held.shift && def.text && /^[a-z]$/.test(def.text) ? def.text.toUpperCase() : def.text;
  const stroke: Stroke = {
    key: held.shift && shifted ? shifted : def.key,
    code: def.code,
    keyCode: def.keyCode,
    ...held,
    ...(typing && shifted !== undefined ? { text: shifted } : {}),
  };
  const primary = isMac ? held.meta && !held.ctrl : held.ctrl && !held.meta;
  if (primary && !held.alt) {
    const command = SHORTCUTS[`${held.shift ? "shift+" : ""}${def.key.toLowerCase()}`];
    if (command) stroke.command = command;
  }
  return stroke;
}

/** Text typed a character at a time; a newline is Enter, so a form can submit on it. */
export function typingStrokes(text: string): Stroke[] {
  return [...text.replace(/\r\n?/g, "\n")].map((char) => {
    if (char === "\n") return parseChord("Enter", false);
    const def = keyDef(char);
    return {
      key: char,
      code: def?.code ?? "",
      keyCode: def?.keyCode ?? 0,
      text: char,
      alt: false,
      ctrl: false,
      meta: false,
      shift: char !== char.toLowerCase(),
    };
  });
}

/**
 * Plays strokes in the page against whatever has focus: keydown, keypress
 * and keyup where a script can cancel them, and between them what the key
 * does when nobody does. Answers with what the last key did.
 */
export const STROKES_SCRIPT = String.raw`(function (strokes) {
  const focusable = 'a[href], button, input, select, textarea, [tabindex], [contenteditable=""], [contenteditable="true"]';
  let did = "";
  for (const k of strokes) {
    const target = document.activeElement || document.body;
    const editable =
      target.isContentEditable ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(target.type));
    const init = {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
      altKey: k.alt, ctrlKey: k.ctrl, metaKey: k.meta, shiftKey: k.shift,
      bubbles: true, cancelable: true, composed: true,
    };
    did = "";
    if (target.dispatchEvent(new KeyboardEvent("keydown", init))) {
      if (k.command) {
        document.execCommand(k.command);
        did = k.command;
      } else if (k.text !== undefined) {
        const pressed = target.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: k.text.charCodeAt(0) }));
        if (pressed && k.key === "Enter") {
          if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
            document.execCommand("insertLineBreak");
            did = "new line";
          } else if (target instanceof HTMLInputElement && target.form) {
            target.form.requestSubmit();
            did = "submitted the form";
          } else if (target instanceof HTMLElement && target.matches("button, a[href], [role=button], summary")) {
            target.click();
            did = "activated it";
          }
        } else if (pressed && editable) {
          document.execCommand("insertText", false, k.text);
        } else if (pressed && k.key === " " && target instanceof HTMLElement && target.matches("button, input[type=checkbox], input[type=radio], [role=button], summary")) {
          target.click();
          did = "activated it";
        } else if (pressed && k.key === " ") {
          window.scrollBy(0, (k.shift ? -0.9 : 0.9) * innerHeight);
        }
      } else if (k.key === "Backspace" && editable) {
        document.execCommand("delete");
      } else if (k.key === "Delete" && editable) {
        document.execCommand("forwardDelete");
      } else if (k.key === "Tab") {
        const all = [...document.querySelectorAll(focusable)].filter(
          (el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0,
        );
        const at = all.indexOf(target);
        const next = all[(at + (k.shift ? -1 : 1) + all.length) % all.length];
        if (next) {
          next.focus();
          did = "focus moved";
        }
      } else if (!editable) {
        const scroll = {
          ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowRight: [40, 0], ArrowLeft: [-40, 0],
          PageDown: [0, 0.9 * innerHeight], PageUp: [0, -0.9 * innerHeight],
          Home: [0, -document.documentElement.scrollHeight], End: [0, document.documentElement.scrollHeight],
        }[k.key];
        if (scroll) window.scrollBy(scroll[0], scroll[1]);
      }
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  return did;
})`;
