/**
 * Subsequence matcher, ported from the renderer's `src/lib/fuzzy.ts` shape.
 * Consecutive characters, word boundaries and a match at the start all score.
 */
export type FuzzyHit = { score: number; positions: number[] };

export function fuzzyMatch(query: string, target: string): FuzzyHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let at = 0;
  let previous = -2;

  for (const char of q) {
    if (char === " ") continue;
    const found = t.indexOf(char, at);
    if (found < 0) return null;
    positions.push(found);
    // Consecutive run.
    if (found === previous + 1) score += 8;
    // Start of the string, or of a word.
    if (found === 0) score += 12;
    else {
      const before = t[found - 1];
      if (before === "/" || before === "-" || before === "_" || before === "." || before === " ") {
        score += 6;
      }
    }
    // Every skipped character costs a little.
    score -= Math.min(found - at, 6);
    previous = found;
    at = found + 1;
  }
  // Shorter targets win ties.
  score -= Math.min(t.length / 12, 8);
  return { score, positions };
}

/** Which characters of `target` matched, for highlighting a palette row. */
export function highlightRuns(target: string, positions: number[]): Array<{ text: string; hit: boolean }> {
  if (positions.length === 0) return [{ text: target, hit: false }];
  const set = new Set(positions);
  const runs: Array<{ text: string; hit: boolean }> = [];
  let buffer = "";
  let mode = set.has(0);
  for (let i = 0; i < target.length; i += 1) {
    const hit = set.has(i);
    if (hit !== mode) {
      if (buffer) runs.push({ text: buffer, hit: mode });
      buffer = "";
      mode = hit;
    }
    buffer += target[i];
  }
  if (buffer) runs.push({ text: buffer, hit: mode });
  return runs;
}

export function rankBy<T>(items: T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const hit = fuzzyMatch(query, text(item));
    if (hit) scored.push({ item, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}
