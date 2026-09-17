import type { SearchHit } from "./protocol";

export type { SearchHit };

/**
 * The daemon marks hits with private-use characters, because a snippet can
 * contain any text an agent produced and `<b>` is text an agent produces.
 */
const OPEN = "";
const CLOSE = "";

export type Run = { text: string; hit: boolean };

/** The snippet split into plain and matched runs, ready to paint. */
export function snippetRuns(snippet: string): Run[] {
  const runs: Run[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(OPEN);
    if (open < 0) break;
    const close = rest.indexOf(CLOSE, open + 1);
    if (close < 0) break;
    if (open > 0) runs.push({ text: rest.slice(0, open), hit: false });
    runs.push({ text: rest.slice(open + 1, close), hit: true });
    rest = rest.slice(close + 1);
  }
  if (rest.length > 0) runs.push({ text: rest, hit: false });
  return runs;
}

export type Range = "any" | "today" | "week" | "month";

export const RANGES: { id: Range; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
];

const DAY = 86_400_000;

/** Start of the window, or undefined for "any time". Today means since midnight. */
export function rangeStart(range: Range, now: number): number | undefined {
  switch (range) {
    case "any":
      return undefined;
    case "today": {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return midnight.getTime();
    }
    case "week":
      return now - 7 * DAY;
    case "month":
      return now - 30 * DAY;
  }
}

/** What the row says a hit is: a user turn, a reply, a tool line. */
export function roleLabel(hit: SearchHit): string {
  switch (hit.role) {
    case "user":
      return "You";
    case "assistant":
      return "Reply";
    case "tool":
      return "Tool";
    case "reasoning":
      return "Thinking";
    case "approval":
      return "Approval";
    case "question":
      return "Question";
    case "system":
      return "Note";
  }
}
