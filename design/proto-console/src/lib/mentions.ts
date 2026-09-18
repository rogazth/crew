import { knownPath } from "./files";

export type Segment = { text: string; path?: string };

const MENTION = /@([\w./-]*[\w/-])/g;

/** `@src/lib/tabs.ts` inside a user message becomes a chip that opens the file. */
export function segmentsOf(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const at = match.index ?? 0;
    const relative = match[1]!;
    if (!knownPath(relative)) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: `@${relative}`, path: relative });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

export type MentionQuery = { start: number; end: number; query: string };

/** The `@…` run the caret is sitting in, if any. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  let start = caret - 1;
  while (start >= 0) {
    const ch = text[start]!;
    if (ch === "@") break;
    if (/\s/.test(ch)) return null;
    start -= 1;
  }
  if (start < 0 || text[start] !== "@") return null;
  const before = start > 0 ? text[start - 1]! : " ";
  if (!/[\s(]/.test(before)) return null;
  return { start, end: caret, query: text.slice(start + 1, caret) };
}

export function completeMention(text: string, at: MentionQuery, relative: string): {
  text: string;
  caret: number;
} {
  const head = `${text.slice(0, at.start)}@${relative} `;
  return { text: head + text.slice(at.end), caret: head.length };
}
