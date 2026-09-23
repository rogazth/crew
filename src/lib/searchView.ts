import type { SearchQuery, SearchSort } from "./protocol";
import { rangeStart, type Range } from "./search";

/** What the page shows. One more is asked for, to know whether to say "+". */
export const SEARCH_PAGE = 100;

/** The daemon query for what the filters say, as of `now`. */
export function searchQuery(
  text: string,
  range: Range,
  sort: SearchSort,
  inSession: string,
  now: number,
): SearchQuery {
  const from = rangeStart(range, now);
  return {
    query: text,
    sessionIds: inSession ? [inSession] : [],
    ...(from === undefined ? {} : { from }),
    sort,
    limit: SEARCH_PAGE + 1,
  };
}

/** Never claim a count the page did not actually reach. */
export function countLabel(found: number): string {
  if (found > SEARCH_PAGE) return `${SEARCH_PAGE}+ results`;
  return found === 1 ? "1 result" : `${found} results`;
}

export function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
