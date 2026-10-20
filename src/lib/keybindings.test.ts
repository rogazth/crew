import { afterEach, describe, expect, it } from "vitest";
import { chordFromPress, parseChord, sameKeyOf } from "./chords";
import { bindingGroups } from "./commandGroups";
import { allKeysFor, commandChords, commandKeys, setKeyOverrides } from "./commands";
import { clashes, exportOverrides, findClash, isEditable, parseImport, readStored, replaceClash, resetOverride, setOverride } from "./keybindings";

afterEach(() => setKeyOverrides({}));

describe("chords", () => {
  it("reads a stored chord and refuses a bare key", () => {
    expect(parseChord("Mod+Shift+K")).toMatchObject({ key: "K", mod: true, shift: true });
    expect(parseChord("Mod++")).toMatchObject({ key: "+", mod: true });
    expect(parseChord("cmd+k")).toMatchObject({ key: "K", meta: true });
    expect(parseChord("K")).toBeNull();
    expect(parseChord("Shift+K")).toBeNull();
    expect(parseChord("F5")).toMatchObject({ key: "F5" });
    expect(parseChord("Mod+Nope")).toBeNull();
    expect(parseChord(4)).toBeNull();
  });

  it("makes ⌘ Mod on macOS and Ctrl elsewhere", () => {
    const press = { key: "k", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(chordFromPress(press, true)).toBe("Mod+K");
    expect(chordFromPress({ ...press, metaKey: false, ctrlKey: true }, false)).toBe("Mod+K");
    expect(chordFromPress({ ...press, metaKey: false, ctrlKey: true }, true)).toBe("Ctrl+K");
    expect(chordFromPress({ ...press, key: "Meta", code: "MetaLeft" }, true)).toBeNull();
  });

  it("compares chords by the key they are on this platform", () => {
    expect(sameKeyOf("Mod+K", true)).toBe(sameKeyOf({ key: "K", meta: true }, true));
    expect(sameKeyOf("Mod+K", false)).toBe(sameKeyOf({ key: "K", ctrl: true }, false));
    expect(sameKeyOf("Mod+}", true)).toBe(sameKeyOf("Mod+]", true));
  });
});

describe("override merge", () => {
  it("rebinds a command and drops the override once it is the default again", () => {
    const moved = setOverride({}, "close", "Mod+Alt+W");
    expect(moved).toEqual({ close: "Mod+Alt+W" });
    expect(setOverride(moved, "close", "Mod+W")).toEqual({});
    expect(resetOverride(moved, "close")).toEqual({});
  });

  it("removes a shortcut as null, and a command with none stays unbound", () => {
    expect(setOverride({}, "close", null)).toEqual({ close: null });
    expect(setOverride({}, "open-routines", null)).toEqual({});
  });

  it("applies to the command's chords and its labels, replacing the extras", () => {
    setKeyOverrides({ "zoom-in": "Mod+Alt+Z", close: null });
    expect(allKeysFor("zoom-in")).toHaveLength(1);
    expect(commandChords("close")).toEqual([]);
    expect(commandKeys("zoom-in")).toContain("Z");
    setKeyOverrides({});
    expect(allKeysFor("zoom-in")).toHaveLength(3);
  });

  it("shows the bound chord and the default in the page's rows", () => {
    setKeyOverrides({ "toggle-outline": "Mod+Ctrl+O" });
    const row = bindingGroups().flatMap((g) => g.rows).find((r) => r.id === "toggle-outline")!;
    expect(row.chords[0]).toContain("O");
    expect(row.defaults).toEqual([]);
  });

  it("spells a plus key", () => {
    const row = bindingGroups().flatMap((g) => g.rows).find((r) => r.id === "zoom-in")!;
    expect(row.chords.some((c) => c.endsWith("+"))).toBe(true);
  });

  it("keeps the numbered runs fixed", () => {
    expect(isEditable("workspace-3")).toBe(false);
    expect(isEditable("close")).toBe(true);
    expect(isEditable("nope")).toBe(false);
  });
});

describe("clash detection", () => {
  it("finds the command on a chord, in either spelling", () => {
    expect(findClash({}, "close", "Mod+K", true)).toBe("open-palette");
    expect(findClash({}, "close", "Meta+K", true)).toBe("open-palette");
    expect(findClash({}, "open-palette", "Mod+K", true)).toBeUndefined();
    expect(findClash({}, "close", "Mod+Alt+9", true)).toBeUndefined();
  });

  it("sees a command's extra chords and overridden ones", () => {
    expect(findClash({}, "close", "Mod+=", true)).toBe("zoom-in");
    expect(findClash({ "open-palette": "Mod+Alt+K" }, "close", "Mod+K", true)).toBeUndefined();
    expect(findClash({ "open-palette": "Mod+Alt+K" }, "close", "Mod+Alt+K", true)).toBe("open-palette");
  });

  it("replaces by unbinding the other command", () => {
    const next = replaceClash({}, "close", "Mod+K", "open-palette", true);
    expect(next).toEqual({ close: "Mod+K", "open-palette": null });
    expect(clashes(next, true)).toEqual([]);
  });

  it("refuses to unbind a fixed command", () => {
    const overrides = { close: "Mod+W" };
    expect(replaceClash(overrides, "close", "Mod+3", "workspace-3", true)).toBe(overrides);
  });

  it("keeps what the other command still ran on", () => {
    const next = replaceClash({}, "close", "Mod+=", "zoom-in", true);
    expect(next["close"]).toBe("Mod+=");
    expect(next["zoom-in"]).not.toBeNull();
    expect(clashes(next, true)).toEqual([]);
  });
});

describe("import", () => {
  it("accepts the exported shape and a bare map", () => {
    const overrides = { close: "Mod+Alt+W", "open-palette": null };
    expect(parseImport(exportOverrides(overrides), true)).toEqual({ ok: true, overrides });
    expect(parseImport(JSON.stringify(overrides), true)).toEqual({ ok: true, overrides });
  });

  it("names every problem and applies nothing", () => {
    const result = parseImport(
      JSON.stringify({ nope: "Mod+J", close: "banana", "workspace-1": "Mod+Alt+1", "new-bot": 3, "reopen-tab": "Mod+K" }),
      true,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toContain("nope");
  });

  it("rejects a file that leaves two commands on one chord", () => {
    const result = parseImport(JSON.stringify({ close: "Mod+K" }), true);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.errors[0]).toMatch(/Close Tab and Command Palette/);
  });

  it("rejects text that is not JSON or not a map", () => {
    expect(parseImport("{", true)).toMatchObject({ ok: false });
    expect(parseImport("[1]", true)).toMatchObject({ ok: false });
  });

  it("reads saved overrides, dropping what no longer holds", () => {
    expect(readStored(null, true)).toEqual({});
    expect(readStored("garbage", true)).toEqual({});
    expect(readStored(JSON.stringify({ close: "Mod+Alt+W", gone: "Mod+J", "new-bot": "x" }), true)).toEqual({ close: "Mod+Alt+W" });
  });
});
