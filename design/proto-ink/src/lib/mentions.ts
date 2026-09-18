import type { ProjectFile } from "@crew/fixtures";
import { rankBy } from "@crew/fixtures";

export type MentionQuery = { start: number; end: number; query: string };

/** The `@…` run the caret currently sits in, if any. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i]!;
    if (ch === "@") {
      const before = i === 0 ? " " : text[i - 1]!;
      if (!/[\s(]/.test(before) && i !== 0) return null;
      const query = text.slice(i + 1, caret);
      if (/\s/.test(query)) return null;
      return { start: i, end: caret, query };
    }
    if (/[\s]/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

export function mentionCandidates(files: ProjectFile[], query: string, limit = 8): ProjectFile[] {
  return rankBy(files, query, (f) => f.relative).slice(0, limit);
}

export function applyMention(text: string, at: MentionQuery, relative: string): { text: string; caret: number } {
  const next = `${text.slice(0, at.start)}@${relative} ${text.slice(at.end)}`;
  return { text: next, caret: at.start + relative.length + 2 };
}

export type Segment = { text: string; mention: boolean };

/** Splits a composed message so the overlay can tint completed mentions. */
export function mentionSegments(text: string, known: Set<string>): Segment[] {
  const out: Segment[] = [];
  const re = /@([^\s@]+)/g;
  let last = 0;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text))) {
    if (!known.has(hit[1]!)) continue;
    if (hit.index > last) out.push({ text: text.slice(last, hit.index), mention: false });
    out.push({ text: hit[0], mention: true });
    last = hit.index + hit[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
