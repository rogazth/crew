/** Between two entries of a bot's notes, as the daemon stores them (`crew_core::notes::SEPARATOR`). */
const SEPARATOR = "\n§\n";

/** One entry being edited in the bot sheet; `key` keeps its row while the text changes. */
export type NoteEntry = { key: number; text: string };

let nextKey = 0;

export function noteEntries(entries: string[]): NoteEntry[] {
  return entries.map((text) => ({ key: nextKey++, text }));
}

export function newNoteEntry(): NoteEntry {
  return { key: nextKey++, text: "" };
}

/** What will be saved: trimmed, the empty ones and repeats dropped, as the daemon tidies them. */
export function noteTexts(entries: NoteEntry[]): string[] {
  const out: string[] = [];
  for (const { text } of entries) {
    const trimmed = text.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Characters the notes take, as the daemon counts them: code points, separators included. */
export function notesUsed(entries: string[]): number {
  const chars = entries.reduce((sum, entry) => sum + [...entry].length, 0);
  return chars + [...SEPARATOR].length * Math.max(0, entries.length - 1);
}

export function sameNotes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}
