import { afterEach, describe, expect, it, vi } from "vitest";
import { PUNCTUATION_CODE_MAP, parseHotkey, rawHotkeyToParsedHotkey, type ParsedHotkey } from "@tanstack/react-hotkeys";
import {
  COMMAND_IDS,
  allKeysFor,
  keysFor,
  liveCommands,
  onCommandsChange,
  registerCommand,
  repeatable,
  runCommand,
  type CommandId,
} from "./commands";
import {
  matchChord,
  resolveForward,
  type ChordInput,
  type ChordSpec,
  type ForwardInput,
  type KeyboardLayout,
  type LiveCommand,
} from "./keymap";

const PLATFORMS = [
  ["macOS", true],
  ["Linux", false],
] as const;

/** tanstack's own reading of a binding, so the canonical events do not lean on ours. */
function tanstackParse(spec: ChordSpec, isMac: boolean): ParsedHotkey {
  const platform = isMac ? "mac" : "linux";
  return typeof spec === "string" ? parseHotkey(spec, platform) : rawHotkeyToParsedHotkey(spec, platform);
}

const PUNCTUATION_KEY_CODES = Object.fromEntries(
  Object.entries(PUNCTUATION_CODE_MAP).map(([code, key]) => [key, code]),
);

function codeFor(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_KEY_CODES[key] ?? "";
}

/** What ⇧ types on a US layout. */
const SHIFTED: Record<string, string> = {
  "[": "{",
  "]": "}",
  ",": "<",
  ".": ">",
  "/": "?",
  ";": ":",
  "\\": "|",
  "`": "~",
  "-": "_",
  "=": "+",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
};

/** What ⌥ types on a US Mac; the accent keys come through as dead keys. */
const MAC_OPTION: Record<string, string> = { i: "ˆ", e: "Dead", n: "Dead", u: "Dead" };

/** The event a US keyboard sends for a binding. */
function canonical(spec: ChordSpec, isMac: boolean): ChordInput {
  const parsed = tanstackParse(spec, isMac);
  const plain = parsed.key.length === 1 ? parsed.key.toLowerCase() : parsed.key;
  let key = plain;
  if (parsed.shift) key = SHIFTED[plain] ?? plain.toUpperCase();
  if (parsed.alt && isMac && /^[a-z]$/.test(plain)) key = MAC_OPTION[plain] ?? plain;
  return { key, code: codeFor(plain), meta: parsed.meta, ctrl: parsed.ctrl, alt: parsed.alt, shift: parsed.shift };
}

const ev = (key: string, mods: Partial<ChordInput> = {}): ChordInput => ({
  key,
  code: codeFor(key),
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

/** Every command that has a binding; the rest are reached from the palette. */
const BOUND = COMMAND_IDS.flatMap((id) => {
  const keys = keysFor(id);
  return keys ? [{ id, keys }] : [];
});

describe("every command's chord", () => {
  for (const [platform, isMac] of PLATFORMS) {
    it.each(BOUND)(`the canonical ${platform} event runs $id and nothing else`, ({ id, keys }) => {
      const event = canonical(keys, isMac);
      expect(BOUND.filter((other) => matchChord(other.keys, event, isMac)).map((other) => other.id)).toEqual([id]);
    });

  }
});

describe("matchChord", () => {
  it("reads Mod as ⌘ on macOS and Ctrl elsewhere", () => {
    expect(matchChord("Mod+T", ev("t", { meta: true }), true)).toBe(true);
    expect(matchChord("Mod+T", ev("t", { ctrl: true }), true)).toBe(false);
    expect(matchChord("Mod+T", ev("t", { ctrl: true }), false)).toBe(true);
    expect(matchChord("Mod+T", ev("t", { meta: true }), false)).toBe(false);
    expect(matchChord({ key: "[", mod: true }, ev("[", { ctrl: true }), false)).toBe(true);
  });

  it("requires the modifiers to match exactly", () => {
    expect(matchChord("Mod+T", ev("T", { meta: true, shift: true }), true)).toBe(false);
    expect(matchChord("Mod+Shift+T", ev("t", { meta: true }), true)).toBe(false);
    expect(matchChord("Mod+Alt+I", ev("i", { meta: true }), true)).toBe(false);
    expect(matchChord("Mod+R", ev("r", { meta: true, ctrl: true }), true)).toBe(false);
    expect(matchChord({ key: "]", ctrl: true, meta: true }, ev("]", { meta: true }), true)).toBe(false);
    expect(matchChord({ key: "]", ctrl: true, meta: true }, ev("]", { ctrl: true }), false)).toBe(false);
  });

  it("compares the key case-insensitively", () => {
    expect(matchChord("Mod+T", ev("T", { meta: true }), true)).toBe(true);
    expect(matchChord({ key: "t", mod: true }, ev("T", { meta: true }), true)).toBe(true);
    expect(matchChord("Mod+,", ev(",", { meta: true }), true)).toBe(true);
  });

  it("reads a brace as its bracket, wherever the key sits", () => {
    // ⌘⇧] types "}" on a US board.
    const spec = { key: "]", mod: true, shift: true };
    expect(matchChord(spec, { ...ev("}", { meta: true, shift: true }), code: "BracketRight" }, true)).toBe(true);
    expect(matchChord(spec, { ...ev("{", { meta: true, shift: true }), code: "BracketLeft" }, true)).toBe(false);
  });

  it("goes by the key typed, not the physical key, when the event names one", () => {
    // A key that types + where a US board has ] is not ⌘].
    expect(matchChord({ key: "]", mod: true }, { ...ev("+", { meta: true }), code: "BracketRight" }, true)).toBe(false);
    expect(matchChord({ key: "]", mod: true }, { ...ev("]", { meta: true }), code: "Backslash" }, true)).toBe(true);
  });

  it("finds a ⌥ dead character by its physical key", () => {
    // ⌥⌘I types "ˆ" on a US Mac, or reports a dead key.
    expect(matchChord("Mod+Alt+I", { ...ev("ˆ", { meta: true, alt: true }), code: "KeyI" }, true)).toBe(true);
    expect(matchChord("Mod+Alt+I", { ...ev("Dead", { meta: true, alt: true }), code: "KeyI" }, true)).toBe(true);
    expect(matchChord("Mod+Alt+I", { ...ev("Dead", { meta: true, alt: true }), code: "KeyU" }, true)).toBe(false);
  });

  it("lets letters follow the layout, not the physical key", () => {
    // Dvorak puts Y where QWERTY has T: ⌘ plus that key is ⌘Y.
    const dvorakY = { ...ev("y", { meta: true }), code: "KeyT" };
    expect(matchChord("Mod+Y", dvorakY, true)).toBe(true);
    expect(matchChord("Mod+T", dvorakY, true)).toBe(false);
    // Dvorak's [ sits on QWERTY's - key; the key it types wins.
    expect(matchChord({ key: "[", mod: true }, { ...ev("[", { meta: true }), code: "Minus" }, true)).toBe(true);
  });

  it("falls back to the physical key only for a character, not a named key", () => {
    expect(matchChord("Mod+L", { ...ev("Enter", { meta: true }), code: "KeyL" }, true)).toBe(false);
  });
});

const press = (key: string, mods: Partial<ForwardInput> = {}): ForwardInput => ({
  type: "keyDown",
  isAutoRepeat: false,
  ...ev(key),
  ...mods,
});

function live(...ids: CommandId[]): LiveCommand[] {
  return ids.map((id) => ({ id, keys: keysFor(id)!, repeat: repeatable(id) }));
}

/** Every chord of each command, as the window publishes them. */
function liveAll(...ids: CommandId[]): LiveCommand[] {
  return ids.flatMap((id) => allKeysFor(id).map((keys) => ({ id, keys, repeat: repeatable(id) })));
}

describe("a US Mac", () => {
  it("opens the shortcuts sheet with ⌘/ and ⌘?", () => {
    const sheet = liveAll("shortcuts");
    expect(resolveForward(press("/", { meta: true, code: "Slash" }), sheet, true)?.id).toBe("shortcuts");
    expect(resolveForward(press("?", { meta: true, shift: true, code: "Slash" }), sheet, true)?.id).toBe("shortcuts");
  });

  it("zooms in with ⌘= and ⌘+", () => {
    const zoom = liveAll("zoom-in");
    expect(resolveForward(press("=", { meta: true, code: "Equal" }), zoom, true)?.id).toBe("zoom-in");
    expect(resolveForward(press("+", { meta: true, shift: true, code: "Equal" }), zoom, true)?.id).toBe("zoom-in");
  });
});

describe("resolveForward", () => {
  it("claims a chord with a live command and runs it", () => {
    const commands = live("open-launcher", "close");
    expect(resolveForward(press("t", { meta: true }), commands, true)).toEqual({ id: "open-launcher", run: true });
    expect(resolveForward(press("w", { ctrl: true }), commands, false)).toEqual({ id: "close", run: true });
  });

  it("leaves a chord without a live command to the page", () => {
    expect(resolveForward(press("t", { meta: true }), live("close"), true)).toBeNull();
    expect(resolveForward(press("q", { meta: true }), live("open-launcher", "close"), true)).toBeNull();
  });

  it("never claims a key up", () => {
    const commands = live("open-launcher");
    expect(resolveForward(press("t", { meta: true, type: "keyUp" }), commands, true)).toBeNull();
  });

  it("leaves bare, ⇧ and ⌥ keys to the page even when something is bound to them", () => {
    const commands: LiveCommand[] = [
      { id: "bare", keys: "T", repeat: false },
      { id: "shift", keys: "Shift+T", repeat: false },
      { id: "alt", keys: "Alt+I", repeat: false },
    ];
    expect(resolveForward(press("t"), commands, true)).toBeNull();
    expect(resolveForward(press("T", { shift: true }), commands, true)).toBeNull();
    expect(resolveForward({ ...press("ˆ", { alt: true }), code: "KeyI" }, commands, true)).toBeNull();
    expect(resolveForward(press("i", { alt: true }), commands, false)).toBeNull();
  });

  it("swallows an auto-repeat without running it, unless the command repeats", () => {
    const held = { meta: true, isAutoRepeat: true };
    expect(resolveForward(press("t", held), live("open-launcher"), true)).toEqual({ id: "open-launcher", run: false });
    const nextTab = { ...press("}", { ...held, shift: true }), code: "BracketRight" };
    expect(resolveForward(nextTab, live("next-tab"), true)).toEqual({ id: "next-tab", run: true });
  });

  for (const [platform, isMac] of PLATFORMS) {
    it(`never claims the page's editing chords on ${platform}, even when bound`, () => {
      const editing: ChordSpec[] = ["Mod+C", "Mod+V", "Mod+X", "Mod+A", "Mod+Z", "Mod+Shift+Z"];
      const commands = editing.map((keys, i): LiveCommand => ({ id: `edit-${i}`, keys, repeat: false }));
      for (const keys of editing) {
        expect(resolveForward({ ...canonical(keys, isMac), type: "keyDown", isAutoRepeat: false }, commands, isMac)).toBeNull();
      }
      // A neighbour of an editing chord is fair game.
      const other: LiveCommand[] = [{ id: "other", keys: "Mod+Shift+C", repeat: false }];
      const event = { ...canonical("Mod+Shift+C", isMac), type: "keyDown", isAutoRepeat: false };
      expect(resolveForward(event, other, isMac)).toEqual({ id: "other", run: true });
    });
  }

  it("skips a malformed binding from the renderer instead of throwing", () => {
    const commands = [
      { id: "no-key", keys: { mod: true } as unknown as ChordSpec, repeat: false },
      { id: "numeric-key", keys: { key: 7, mod: true } as unknown as ChordSpec, repeat: false },
      { id: "trailing-plus", keys: "Mod+", repeat: false },
      { id: "close", keys: "Mod+W", repeat: false },
    ];
    expect(resolveForward(press("7", { meta: true }), commands, true)).toBeNull();
    expect(resolveForward(press("w", { meta: true }), commands, true)).toEqual({ id: "close", run: true });
  });

  it("takes the first live command that matches", () => {
    const commands: LiveCommand[] = [
      { id: "first", keys: "Mod+K", repeat: false },
      { id: "second", keys: "Mod+K", repeat: false },
    ];
    expect(resolveForward(press("k", { meta: true }), commands, true)).toEqual({ id: "first", run: true });
  });

  it("keeps Back apart from the worktree pair on both platforms", () => {
    const commands = live("prev-worktree", "browser-back");
    expect(resolveForward(press("[", { ctrl: true }), commands, false)).toEqual({ id: "browser-back", run: true });
    expect(resolveForward(press("[", { meta: true }), commands, true)).toEqual({ id: "browser-back", run: true });
    expect(resolveForward(press("[", { meta: true, ctrl: true }), commands, true)).toEqual({
      id: "prev-worktree",
      run: true,
    });
  });
});

/**
 * macOS's Latin American layout, as UCKeyTranslate reads it: { [ and } ] sit
 * where a US board has ' and \, and the keys a US board calls [ and ] type a
 * dead ´ and +. ⌥ on the brace keys is a dead key.
 */
const LATAM: KeyboardLayout = {
  BracketLeft: "´",
  BracketRight: "+",
  Quote: "{",
  Backslash: "}",
  Semicolon: "ñ",
  Minus: "'",
  Equal: "¿",
  KeyI: "i",
  Digit1: "1",
};

describe("a Latin American Mac", () => {
  const commands = live(
    "next-tab",
    "prev-tab",
    "next-workspace",
    "prev-workspace",
    "next-worktree",
    "prev-worktree",
    "worktree-1",
    "browser-back",
    "browser-forward",
    "browser-devtools",
  );
  const run = (key: string, code: string, mods: Partial<ForwardInput>) =>
    resolveForward(press(key, { ...mods, code }), commands, true, LATAM)?.id ?? null;

  it("goes back and forward with ⌘ on the { and } keys", () => {
    expect(run("{", "Quote", { meta: true })).toBe("browser-back");
    expect(run("}", "Backslash", { meta: true })).toBe("browser-forward");
  });

  it("leaves ⌘´ and ⌘+ alone, though they sit where a US board has [ and ]", () => {
    expect(run("Dead", "BracketLeft", { meta: true })).toBeNull();
    expect(run("´", "BracketLeft", { meta: true })).toBeNull();
    expect(run("+", "BracketRight", { meta: true })).toBeNull();
  });

  it("switches workspaces with ⌘⌥ on the { and } keys, which ⌥ makes dead", () => {
    expect(run("Dead", "Quote", { meta: true, alt: true })).toBe("prev-workspace");
    expect(run("Dead", "Backslash", { meta: true, alt: true })).toBe("next-workspace");
    expect(run("}", "Backslash", { meta: true, alt: true })).toBe("next-workspace");
  });

  it("does not switch workspaces with ⌘⌥´ or ⌘⌥+", () => {
    expect(run("«", "BracketLeft", { meta: true, alt: true })).toBeNull();
    expect(run("Dead", "BracketRight", { meta: true, alt: true })).toBeNull();
  });

  it("cycles tabs and worktrees on the same keys", () => {
    expect(run("]", "Backslash", { meta: true, shift: true })).toBe("next-tab");
    expect(run("[", "Quote", { meta: true, shift: true })).toBe("prev-tab");
    expect(run("}", "Backslash", { meta: true, ctrl: true })).toBe("next-worktree");
    expect(run("{", "Quote", { meta: true, ctrl: true })).toBe("prev-worktree");
    expect(run("1", "Digit1", { meta: true, ctrl: true })).toBe("worktree-1");
  });

  it("still reads ⌥ letters by the key under them", () => {
    expect(run("ˆ", "KeyI", { meta: true, alt: true })).toBe("browser-devtools");
  });

  it("opens the shortcuts sheet with ⇧⌘7, where / is typed", () => {
    const sheet = liveAll("shortcuts", "zoom-out");
    expect(resolveForward(press("/", { meta: true, shift: true, code: "Digit7" }), sheet, true, LATAM)?.id).toBe("shortcuts");
    // The key a US board calls / types - here: that is zoom out, not the sheet.
    expect(resolveForward(press("-", { meta: true, code: "Slash" }), sheet, true, LATAM)?.id).toBe("zoom-out");
  });

  it("zooms in with ⌘+, the key that types +", () => {
    expect(resolveForward(press("+", { meta: true, code: "BracketRight" }), liveAll("zoom-in"), true, LATAM)?.id).toBe("zoom-in");
  });

  it("falls back to the US key when no layout has been read", () => {
    const id = resolveForward(press("Dead", { meta: true, alt: true, code: "BracketRight" }), commands, true)?.id;
    expect(id).toBe("next-workspace");
  });
});

describe("live commands", () => {
  let unbinds: (() => void)[] = [];
  const bind = (id: CommandId, handler: () => void = () => {}) => {
    const unbind = registerCommand(id, handler);
    unbinds.push(unbind);
    return unbind;
  };
  const flush = () => Promise.resolve();

  afterEach(async () => {
    for (const unbind of unbinds) unbind();
    unbinds = [];
    await flush();
  });

  it("marks only tab cycling as repeatable", () => {
    expect(COMMAND_IDS.filter(repeatable)).toEqual(["next-tab", "prev-tab"]);
  });

  it("lists the commands with a handler, in declaration order, with keys and repeat", () => {
    expect(liveCommands()).toEqual([]);
    bind("next-tab");
    bind("open-launcher");
    expect(liveCommands()).toEqual([
      { id: "open-launcher", keys: "Mod+T", repeat: false },
      { id: "next-tab", keys: { key: "]", mod: true, shift: true }, repeat: true },
    ]);
  });

  it("cycles tabs with ⇧ on the bracket keys, wherever the layout puts them", () => {
    bind("next-tab");
    bind("prev-tab");
    const commands = liveCommands();
    // US: ⇧⌘] types }. Latin American: ⇧ on the } key types ].
    expect(resolveForward(press("}", { meta: true, shift: true, code: "BracketRight" }), commands, true)?.id).toBe("next-tab");
    expect(resolveForward(press("]", { meta: true, shift: true, code: "Backslash" }), commands, true)?.id).toBe("next-tab");
    expect(resolveForward(press("[", { meta: true, shift: true, code: "Quote" }), commands, true)?.id).toBe("prev-tab");
  });

  it("leaves out a live command with no binding: a page has nothing to forward", () => {
    bind("open-routines");
    bind("close");
    expect(liveCommands().map((c) => c.id)).toEqual(["close"]);
  });

  it("gives ⌘⇧R to the page's hard reload, not to Routines", () => {
    expect(keysFor("browser-hard-reload")).toBe("Mod+Shift+R");
    expect(keysFor("open-routines")).toBeUndefined();
  });

  it("drops a command once its handler unregisters", () => {
    const unbind = bind("close");
    unbind();
    expect(liveCommands()).toEqual([]);
  });

  it("notifies once per microtask, however many commands changed", async () => {
    const cb = vi.fn();
    const stop = onCommandsChange(cb);
    bind("open-launcher");
    bind("close");
    bind("reopen-tab");
    expect(cb).not.toHaveBeenCalled();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it("notifies when a command goes away", async () => {
    const cb = vi.fn();
    const stop = onCommandsChange(cb);
    const unbind = bind("close");
    await flush();
    cb.mockClear();
    unbind();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stays quiet when a live command only gets a new handler", async () => {
    const cb = vi.fn();
    const stop = onCommandsChange(cb);
    const first = vi.fn();
    const second = vi.fn();
    const unbindFirst = bind("close", first);
    await flush();
    cb.mockClear();

    bind("close", second);
    // The first handler's late unregister must not take the second one down.
    unbindFirst();
    await flush();
    expect(cb).not.toHaveBeenCalled();
    expect(liveCommands().map((c) => c.id)).toEqual(["close"]);
    runCommand("close");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    stop();
  });

  it("stays quiet when the set comes out the same within a microtask", async () => {
    const cb = vi.fn();
    const stop = onCommandsChange(cb);
    const unbind = bind("close");
    await flush();
    cb.mockClear();

    unbind();
    bind("close");
    await flush();
    expect(cb).not.toHaveBeenCalled();
    stop();
  });

  it("stops notifying after unsubscribe", async () => {
    const cb = vi.fn();
    onCommandsChange(cb)();
    bind("close");
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});
