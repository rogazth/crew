import { fuzzyMatch } from "./fuzzy";
import type { ProjectFile } from "./types";

/** `@src/lib/tabs.ts` in a draft: the path characters after the at sign. */
const MENTION = /@([\w./~-]+)/g;

export type Segment = { kind: "text"; text: string } | { kind: "mention"; path: string; text: string };

/** The mention being typed at the caret, if the caret sits inside one. */
export function mentionAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  let end = cursor;
  while (end < text.length && /[\w./~-]/.test(text[end]!)) end += 1;
  return { start: at, end, query };
}

/** Text split into runs, so a bubble or an overlay can paint the mentions. */
export function splitMentions(text: string, known?: Set<string>): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const path = match[1]!;
    const index = match.index ?? 0;
    if (known && !known.has(path)) continue;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    segments.push({ kind: "mention", path, text: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** Files the draft names, in order, without repeats. */
export function mentionedFiles(text: string, files: ProjectFile[]): ProjectFile[] {
  const byRelative = new Map(files.map((file) => [file.relative, file]));
  const seen = new Set<string>();
  const found: ProjectFile[] = [];
  for (const match of text.matchAll(MENTION)) {
    const file = byRelative.get(match[1]!);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    found.push(file);
  }
  return found;
}

export function searchFiles(query: string, files: ProjectFile[], limit = 8): ProjectFile[] {
  if (!query) return files.slice(0, limit);
  const hits: Array<{ file: ProjectFile; score: number }> = [];
  for (const file of files) {
    const hit = fuzzyMatch(query, file.relative);
    if (hit) hits.push({ file, score: hit.score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit).map((hit) => hit.file);
}

/** Replaces the mention under the caret with the chosen file; returns the new text and caret. */
export function completeMention(
  text: string,
  cursor: number,
  file: ProjectFile,
): { text: string; cursor: number } | null {
  const active = mentionAt(text, cursor);
  if (!active) return null;
  const inserted = `@${file.relative} `;
  const next = text.slice(0, active.start) + inserted + text.slice(active.end);
  return { text: next, cursor: active.start + inserted.length };
}
