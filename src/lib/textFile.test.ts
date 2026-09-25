import { describe, expect, it } from "vitest";
import { isDirty, reconcile, resolve, type TextFile } from "./textFile";

const clean: TextFile = { base: "v1", mine: "v1", conflict: false };
const dirty: TextFile = { base: "v1", mine: "v1 mine", conflict: false };

describe("reconcile", () => {
  it("does nothing while neither side changed", () => {
    expect(reconcile(clean, "v1", false)).toEqual({ file: clean, write: false, reload: false });
    expect(reconcile(clean, "v1", true)).toEqual({ file: clean, write: false, reload: false });
    expect(reconcile(dirty, "v1", false)).toEqual({ file: dirty, write: false, reload: false });
  });

  it("saves an edit while the disk still reads its base, which becomes the edit", () => {
    expect(reconcile(dirty, "v1", true)).toEqual({
      file: { base: "v1 mine", mine: "v1 mine", conflict: false },
      write: true,
      reload: false,
    });
  });

  it("takes a change on disk silently when nothing is unsaved", () => {
    for (const save of [false, true]) {
      expect(reconcile(clean, "v2", save)).toEqual({
        file: { base: "v2", mine: "v2", conflict: false },
        write: false,
        reload: true,
      });
    }
  });

  it("keeps the edit and asks when the disk changed under it, on a save or not", () => {
    for (const save of [false, true]) {
      expect(reconcile(dirty, "v2", save)).toEqual({ file: { ...dirty, conflict: true }, write: false, reload: false });
    }
  });

  it("writes nothing on a save while it is asking", () => {
    const asking = { ...dirty, conflict: true };
    expect(reconcile(asking, "v2", true)).toEqual({ file: asking, write: false, reload: false });
    // The disk went back to the base: the question is gone, and the next save writes.
    const settled = reconcile(asking, "v1", true);
    expect(settled).toEqual({ file: dirty, write: false, reload: false });
    expect(reconcile(settled.file, "v1", true).write).toBe(true);
  });

  it("stops asking once the disk reads the edit", () => {
    expect(reconcile({ ...dirty, conflict: true }, "v1 mine", false)).toEqual({
      file: { base: "v1 mine", mine: "v1 mine", conflict: false },
      write: false,
      reload: false,
    });
  });

  it("keeps showing a file removed under a clean editor, and asks when an edit meets the gap", () => {
    expect(reconcile(clean, null, false)).toEqual({ file: clean, write: false, reload: false });
    expect(reconcile(dirty, null, false)).toEqual({ file: { ...dirty, conflict: true }, write: false, reload: false });
    expect(reconcile(dirty, null, true)).toEqual({ file: { ...dirty, conflict: true }, write: false, reload: false });
  });

  it("writes a file that was not there when it loaded, while it still is not", () => {
    const fresh: TextFile = { base: null, mine: "new", conflict: false };
    expect(isDirty({ base: null, mine: "", conflict: false })).toBe(false);
    expect(reconcile(fresh, null, true)).toEqual({
      file: { base: "new", mine: "new", conflict: false },
      write: true,
      reload: false,
    });
  });
});

describe("resolve", () => {
  const asking = { ...dirty, conflict: true };

  it("Overwrite writes the edit, which becomes the base", () => {
    const step = resolve(asking, "v2", "overwrite");
    expect(step).toEqual({ file: { base: "v1 mine", mine: "v1 mine", conflict: false }, write: true, reload: false });
    // The next check finds the disk as written: nothing to do.
    expect(reconcile(step.file, "v1 mine", true)).toEqual({ file: step.file, write: false, reload: false });
  });

  it("Overwrite recreates a removed file", () => {
    expect(resolve(asking, null, "overwrite")).toMatchObject({ file: { base: "v1 mine" }, write: true });
  });

  it("Reload takes the disk, which becomes the base, and drops the edit", () => {
    const step = resolve(asking, "v2", "reload");
    expect(step).toEqual({ file: { base: "v2", mine: "v2", conflict: false }, write: false, reload: true });
    expect(isDirty(step.file)).toBe(false);
    expect(reconcile(step.file, "v2", true)).toEqual({ file: step.file, write: false, reload: false });
  });

  it("Reload of a removed file empties the editor, with nothing unsaved", () => {
    const step = resolve(asking, null, "reload");
    expect(step).toEqual({ file: { base: null, mine: "", conflict: false }, write: false, reload: true });
    expect(isDirty(step.file)).toBe(false);
  });
});
