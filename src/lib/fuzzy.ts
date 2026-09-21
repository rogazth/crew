/** Sequential fuzzy match: every query character appears in order, scored so
 *  that segment starts, camelCase boundaries and unbroken runs win. */

export type FuzzyHit = {
  score: number;
  positions: number[];
};

const RUN = 8;
const SEGMENT_START = 16;
const CAMEL_START = 12;
/** A path repeats its letters, and each repeat is another start to try. Trying
 *  every one turns a 20k-file list quadratic; the best match is never this far in. */
const MAX_STARTS = 16;

export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, positions: [] };
  if (tokens.length === 1) return matchToken(tokens[0]!, text);

  const positions: number[] = [];
  let score = 0;
  for (const token of tokens) {
    const hit = matchToken(token, text);
    if (!hit) return null;
    score += hit.score;
    positions.push(...hit.positions);
  }
  positions.sort((a, b) => a - b);
  return { score, positions };
}

function matchToken(query: string, text: string): FuzzyHit | null {
  if (!query) return { score: 0, positions: [] };

  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const head = needle[0]!;

  let best: FuzzyHit | null = null;
  let starts = 0;
  for (let i = 0; i < hay.length && starts < MAX_STARTS; i++) {
    if (hay[i] !== head) continue;
    starts += 1;
    const hit = scoreFrom(needle, hay, text, i);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

/** Take the earliest character that fits, from `start` on, and score what it took. */
function scoreFrom(
  needle: string,
  hay: string,
  text: string,
  start: number,
): FuzzyHit | null {
  const positions: number[] = [];
  let score = needle.length;
  let qi = 0;

  for (let i = start; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) continue;
    if (i > 0 && positions[positions.length - 1] === i - 1) score += RUN;
    else if (i === 0 || isBreak(text[i - 1]!)) score += SEGMENT_START;
    else if (isUpper(text[i]!) && !isUpper(text[i - 1]!)) score += CAMEL_START;
    positions.push(i);
    qi += 1;
  }

  if (qi !== needle.length) return null;
  return { score: score - (text.length - needle.length), positions };
}

function isBreak(ch: string): boolean {
  return ch === "/" || ch === "\\" || ch === "-" || ch === "_" || ch === "." || ch === " ";
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}
