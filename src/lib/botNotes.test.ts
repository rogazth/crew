import { describe, expect, it } from "vitest";
import { noteEntries, noteTexts, notesUsed, sameNotes } from "./botNotes";

describe("bot notes", () => {
  it("saves what the daemon would keep: trimmed, no empties, no repeats", () => {
    expect(noteTexts(noteEntries([" silla: 7731942 ", "", "mesa", "mesa"]))).toEqual(["silla: 7731942", "mesa"]);
  });

  it("counts characters the way the daemon caps them", () => {
    expect(notesUsed([])).toBe(0);
    expect(notesUsed(["ab", "cd"])).toBe(7);
    // One emoji is one character, not two UTF-16 units.
    expect(notesUsed(["🪑"])).toBe(1);
  });

  it("tells an edit from the notes as they were", () => {
    expect(sameNotes(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameNotes(["a", "b"], ["b", "a"])).toBe(false);
  });
});
