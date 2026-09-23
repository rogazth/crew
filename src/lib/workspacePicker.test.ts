import { describe, expect, it } from "vitest";
import { IS_MAC } from "./hotkey";
import { SEARCHABLE_FROM, digitRow, isSearchable, jumpCommand, workspaceRowKey } from "./workspacePicker";

const bare = (key: string) => ({ key, metaKey: false, ctrlKey: false });

describe("isSearchable", () => {
  it("adds a search field from eight workspaces on", () => {
    expect(SEARCHABLE_FROM).toBe(8);
    expect(isSearchable(7)).toBe(false);
    expect(isSearchable(8)).toBe(true);
  });
});

describe("jumpCommand", () => {
  it("names the jump chord for the first nine rows", () => {
    expect(jumpCommand(0)).toBe("workspace-1");
    expect(jumpCommand(8)).toBe("workspace-9");
  });

  it("has no chord from the tenth row on", () => {
    expect(jumpCommand(9)).toBeNull();
  });
});

describe("digitRow", () => {
  it("picks rows 1 to 9 by their digit", () => {
    expect(digitRow(bare("1"), false)).toBe(0);
    expect(digitRow(bare("9"), false)).toBe(8);
  });

  it("leaves 0 and other keys alone", () => {
    expect(digitRow(bare("0"), false)).toBeNull();
    expect(digitRow(bare("a"), false)).toBeNull();
    expect(digitRow(bare("12"), false)).toBeNull();
  });

  it("leaves digits to the search field while filtering", () => {
    expect(digitRow(bare("2"), true)).toBeNull();
  });

  it("leaves digits held with ⌘ or Ctrl to the app's jump chords", () => {
    expect(digitRow({ key: "2", metaKey: true, ctrlKey: false }, false)).toBeNull();
    expect(digitRow({ key: "2", metaKey: false, ctrlKey: true }, false)).toBeNull();
  });
});

describe("workspaceRowKey", () => {
  it("opens the rename menu on F2", () => {
    expect(workspaceRowKey({ key: "F2", metaKey: false })).toBe("rename");
  });

  it("removes on the platform's delete chord", () => {
    const chord = IS_MAC ? { key: "Backspace", metaKey: true } : { key: "Delete", metaKey: false };
    expect(workspaceRowKey(chord)).toBe("remove");
  });

  it("ignores other keys", () => {
    expect(workspaceRowKey({ key: "Enter", metaKey: false })).toBeNull();
  });
});
