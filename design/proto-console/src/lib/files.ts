import { fuzzyMatch, type ProjectFile } from "@crew/fixtures";
import { store } from "./store";

let cachedFor: ProjectFile[] | null = null;
let known = new Set<string>();
let lower: string[] = [];

function index(): void {
  const files = store.state.files;
  if (cachedFor === files) return;
  cachedFor = files;
  known = new Set(files.map((file) => file.relative));
  lower = files.map((file) => file.relative.toLowerCase());
}

/**
 * "Is this string a file in the project?" is asked for every text node of every
 * markdown block, so it has to be a set lookup, and the set has to follow the
 * data source rather than a fixture import.
 */
export function knownPath(relative: string): boolean {
  index();
  return known.has(relative) || known.has(relative.replace(/^\.\//, ""));
}

export const allFiles = (): ProjectFile[] => store.state.files;

/** A subsequence test that allocates nothing, over a lowercase index built once. */
function couldMatch(target: string, needle: string): boolean {
  let at = 0;
  for (let i = 0; i < needle.length; i += 1) {
    const found = target.indexOf(needle[i]!, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

const SCORE_BUDGET = 3_000;

/**
 * Ranking twenty thousand paths on every keystroke is the palette's only real
 * cost. `fuzzyMatch` lowercases its target each call, so the cheap subsequence
 * pass runs against a cached lowercase index first and only the survivors —
 * capped, because nobody reads past the first screen — are scored properly.
 */
export function rankFiles(query: string, limit: number): ProjectFile[] {
  index();
  const files = cachedFor ?? [];
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return files.slice(0, limit);

  const candidates: number[] = [];
  for (let i = 0; i < lower.length && candidates.length < SCORE_BUDGET; i += 1) {
    if (couldMatch(lower[i]!, needle)) candidates.push(i);
  }

  const scored: Array<{ file: ProjectFile; score: number }> = [];
  for (const i of candidates) {
    const file = files[i]!;
    const hit = fuzzyMatch(query, file.relative);
    if (hit) scored.push({ file, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.file);
}
