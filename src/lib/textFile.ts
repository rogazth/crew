/**
 * A text file open for editing, against the disk under it. The disk is read
 * again on a save, on a return to the tab and when the window comes back; a
 * change found there is taken silently only while nothing here is unsaved, and
 * is never written over without asking. Neither side is ever dropped unasked.
 */

/** What the disk holds: the file's text, or null when there is no file. */
export type Disk = string | null;

export type TextFile = {
  /** What the disk held when the editor last loaded or saved it. */
  base: Disk;
  /** The editor's text. */
  mine: string;
  /** Both the disk and the editor changed since `base`: the editor asks which one wins. */
  conflict: boolean;
};

/** The file after a check, and what that takes: writing `file.mine`, or putting it in the editor. */
export type Step = { file: TextFile; write: boolean; reload: boolean };

export const isDirty = (file: TextFile) => file.mine !== (file.base ?? "");

/**
 * The file once the disk has been read again, `save` when the user asked to
 * write it. While the editor is asking, a save writes nothing: the answer is
 * one of the two buttons.
 */
export function reconcile(file: TextFile, disk: Disk, save: boolean): Step {
  const stay = { write: false, reload: false };
  // The disk already reads what the editor has, whoever wrote it: nothing is unsaved.
  if (disk === file.mine) return { file: { base: disk, mine: file.mine, conflict: false }, ...stay };
  if (disk === file.base) {
    const write = save && !file.conflict && isDirty(file);
    return { file: { base: write ? file.mine : file.base, mine: file.mine, conflict: false }, write, reload: false };
  }
  if (!isDirty(file)) {
    // A file removed under a clean editor: it keeps showing what was there, and a later edit asks.
    if (disk === null) return { file: { ...file, conflict: false }, ...stay };
    return { file: { base: disk, mine: disk, conflict: false }, write: false, reload: true };
  }
  return { file: { ...file, conflict: true }, ...stay };
}

/** The editor's answer: Reload takes the disk and drops the edits, Overwrite writes them over it. */
export function resolve(file: TextFile, disk: Disk, choice: "reload" | "overwrite"): Step {
  if (choice === "overwrite") return { file: { base: file.mine, mine: file.mine, conflict: false }, write: true, reload: false };
  return { file: { base: disk, mine: disk ?? "", conflict: false }, write: false, reload: true };
}
