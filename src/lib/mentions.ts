import { fuzzyMatch } from "./fuzzy";
import type { FolderEntry } from "./protocol";
import type { ProjectFile } from "./types";

/** A file or a folder the `@` menu offers; a folder's `relative` ends in `/`. */
export type MentionChoice = ProjectFile & { dir?: boolean };

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

export function searchFiles<T extends ProjectFile>(query: string, files: T[], limit = 8): T[] {
  if (!query) return files.slice(0, limit);
  const hits: Array<{ file: T; score: number }> = [];
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
  // A folder stays open: the menu goes on to what is in it.
  const inserted = file.relative.endsWith("/") ? `@${file.relative}` : `@${file.relative} `;
  const next = text.slice(0, active.start) + inserted + text.slice(active.end);
  return { text: next, cursor: active.start + inserted.length };
}

/** The folders the index's files sit in, each once, as choices of their own. */
export function foldersOf(files: ProjectFile[], root: string): MentionChoice[] {
  const seen = new Set<string>();
  const folders: MentionChoice[] = [];
  for (const file of files) {
    for (let cut = file.relative.lastIndexOf("/"); cut > 0; cut = file.relative.lastIndexOf("/", cut - 1)) {
      const relative = file.relative.slice(0, cut + 1);
      if (seen.has(relative)) break;
      seen.add(relative);
      const name = relative.slice(relative.lastIndexOf("/", cut - 1) + 1);
      folders.push({ name, relative, path: `${root}/${relative.slice(0, -1)}`, dir: true });
    }
  }
  return folders;
}

/** `reference/t3` → the folder `reference/` and what to look for in it, `t3`. */
export function mentionFolder(query: string): { folder: string; rest: string } {
  const cut = query.lastIndexOf("/");
  return { folder: cut < 0 ? "" : query.slice(0, cut + 1), rest: query.slice(cut + 1) };
}

/**
 * A folder's entries as choices: the ones whose name starts with `rest` first,
 * then the ones that hold it, folders before files. This is what reaches into
 * a folder the index leaves out, like a large one git ignores.
 */
export function folderChoices(entries: FolderEntry[], folder: string, rest: string): MentionChoice[] {
  const lower = rest.toLowerCase();
  const rank = (name: string) => (name.toLowerCase().startsWith(lower) ? 0 : name.toLowerCase().includes(lower) ? 1 : 2);
  return entries
    .filter((entry) => rank(entry.name) < 2 && (rest.startsWith(".") || !entry.name.startsWith(".")))
    .sort((a, b) => rank(a.name) - rank(b.name) || Number(b.dir) - Number(a.dir))
    .map((entry) => ({
      name: entry.dir ? `${entry.name}/` : entry.name,
      path: entry.path,
      relative: `${folder}${entry.name}${entry.dir ? "/" : ""}`,
      ...(entry.dir ? { dir: true } : {}),
    }));
}

/** The menu: what the folder holds first, then the index's matches, each path once. */
export function mergeChoices(listed: MentionChoice[], found: MentionChoice[], limit = 8): MentionChoice[] {
  const seen = new Set<string>();
  const merged: MentionChoice[] = [];
  for (const choice of [...listed, ...found]) {
    if (seen.has(choice.relative)) continue;
    seen.add(choice.relative);
    merged.push(choice);
    if (merged.length === limit) break;
  }
  return merged;
}

/**
 * Paths picked from the menu that the index does not hold (a folder, a file in
 * an ignored one), by absolute path: the message that names them sends them.
 */
const picked = new Set<string>();

export function rememberMention(path: string) {
  picked.add(path.replace(/\/+$/, ""));
}

export function wasPicked(path: string): boolean {
  return picked.has(path.replace(/\/+$/, ""));
}

/** The `@` tokens of a draft, in order, without repeats. */
export function mentionTokens(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(MENTION), (match) => match[1]!))];
}
