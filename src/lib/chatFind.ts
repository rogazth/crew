/**
 * Marking what a chat's find matched, the way the daemon matched it. The index
 * is FTS5 with its unicode61 tokenizer: words are runs of letters and digits,
 * case and accents do not count, and the query's last word is a prefix so the
 * marks move while you type. Marking anything looser would light words the
 * search never counted; anything stricter would leave a hit with nothing lit.
 */

const WORD = /[\p{L}\p{N}]/u;
const TERM = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}/gu;

function foldChar(char: string): string {
  return char.normalize("NFD").replace(MARKS, "").toLowerCase();
}

/** The words of a query as the index reads them, folded. */
export function findTerms(query: string): string[] {
  return [...foldChar(query).matchAll(TERM)].map((match) => match[0]);
}

/**
 * `text` folded, with where each folded character came from: a character can
 * fold to more than one (İ) or to nothing (a lone combining mark).
 */
function fold(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const char of text) {
    const next = at + char.length;
    const part = foldChar(char);
    folded += part;
    // Per UTF-16 unit, as `indexOf` counts: an emoji is two.
    for (let unit = 0; unit < part.length; unit += 1) {
      from.push(at);
      to.push(next);
    }
    at = next;
  }
  return { folded, from, to };
}

/**
 * Where `terms` appear in `text`, as [start, end) offsets into `text`, in order.
 * Every term starts a word; all but the last also end one, as FTS5 matches them.
 */
export function matchOffsets(text: string, terms: readonly string[]): [number, number][] {
  if (terms.length === 0 || text.length === 0) return [];
  const { folded, from, to } = fold(text);
  const found: [number, number][] = [];
  terms.forEach((term, index) => {
    const prefix = index === terms.length - 1;
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + 1)) {
      const end = at + term.length;
      if (at > 0 && WORD.test(folded[at - 1]!)) continue;
      if (!prefix && end < folded.length && WORD.test(folded[end]!)) continue;
      found.push([from[at]!, to[end - 1]!]);
    }
  });
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  // A term inside another one's match ("deploy deployment") is one mark, not two.
  const merged: [number, number][] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}
