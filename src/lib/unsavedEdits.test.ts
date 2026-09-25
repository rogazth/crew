import { describe, expect, it } from "vitest";
import { discardEdits, fileName, holdEdits, onDiscard, unsavedEdits, unsavedTabs, type FileTab } from "./unsavedEdits";
import type { Tab } from "./types";

const file = (path: string): FileTab => ({ id: `file:${path}`, kind: "file", path, relative: path.slice(1) });

describe("unsavedEdits", () => {
  it("holds a file's edits while they differ from the disk, and forgets it once they do not", () => {
    holdEdits("/w/a.ts", { base: "v1", mine: "v1 mine", conflict: false });
    expect(unsavedEdits("/w/a.ts")?.mine).toBe("v1 mine");
    holdEdits("/w/a.ts", { base: "v1 mine", mine: "v1 mine", conflict: false });
    expect(unsavedEdits("/w/a.ts")).toBeUndefined();
  });

  it("finds the file tabs with unsaved edits, and only those", () => {
    holdEdits("/w/dirty.md", { base: "", mine: "new", conflict: false });
    const tabs: Tab[] = [
      file("/w/dirty.md"),
      file("/w/clean.ts"),
      { id: "session:s1", kind: "session", sessionId: "s1" },
    ];
    expect(unsavedTabs(tabs).map((tab) => tab.path)).toEqual(["/w/dirty.md"]);
    discardEdits("/w/dirty.md");
    expect(unsavedTabs(tabs)).toEqual([]);
  });

  it("tells every listener which file a close discarded, until it unsubscribes", () => {
    const heard: string[] = [];
    const off = onDiscard((path) => heard.push(path));
    holdEdits("/w/b.ts", { base: "v1", mine: "v2", conflict: true });
    discardEdits("/w/b.ts");
    expect(unsavedEdits("/w/b.ts")).toBeUndefined();
    off();
    discardEdits("/w/c.ts");
    expect(heard).toEqual(["/w/b.ts"]);
  });

  it("names a file by the last part of its path", () => {
    expect(fileName({ ...file("/w/src/app.ts"), relative: "src/app.ts" })).toBe("app.ts");
  });
});
