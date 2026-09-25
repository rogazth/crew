import { isDirty, type TextFile } from "./textFile";
import type { Tab } from "./types";

/**
 * Every file's unsaved edits, wherever they sit: under the editor on screen,
 * or kept after its tab went away. Whatever closes a tab reads it at once, and
 * a close that discards them drops them here and from every editor that keeps
 * a copy of its own (document, undo history, place in the file).
 */
const held = new Map<string, TextFile>();
const listeners = new Set<(path: string) => void>();

export type FileTab = Extract<Tab, { kind: "file" }>;

/** The edits `path` holds against the disk, if any. */
export const unsavedEdits = (path: string): TextFile | undefined => held.get(path);

/** What the editor of `path` holds now; a file with nothing unsaved is forgotten. */
export function holdEdits(path: string, file: TextFile): void {
  if (isDirty(file)) held.set(path, file);
  else held.delete(path);
}

/** A close gave `path`'s edits up: the file opens again as the disk has it. */
export function discardEdits(path: string): void {
  held.delete(path);
  for (const listener of listeners) listener(path);
}

/** Called with each path whose edits are discarded. Returns the unsubscribe. */
export function onDiscard(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The file tabs among `tabs` that closing would lose edits of. */
export function unsavedTabs(tabs: Tab[]): FileTab[] {
  return tabs.filter((tab): tab is FileTab => tab.kind === "file" && held.has(tab.path));
}

/** How a prompt names a file: the last part of its path. */
export const fileName = (tab: FileTab) => tab.relative.split("/").pop() ?? tab.relative;
