import type { Block, SearchHit } from "./types";
import { threads } from "./data/threads";
import { sessions } from "./data/workspace";

export const MARK_OPEN = "";
export const MARK_CLOSE = "";

export type Run = { text: string; hit: boolean };

/** The snippet split into plain and matched runs, ready to paint. */
export function snippetRuns(snippet: string): Run[] {
  const runs: Run[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(MARK_OPEN);
    if (open < 0) break;
    const close = rest.indexOf(MARK_CLOSE, open + 1);
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

export function roleLabel(role: Block["role"]): string {
  switch (role) {
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

export type SearchQuery = {
  query: string;
  sessionIds?: string[];
  from?: number;
  to?: number;
  sort?: "relevance" | "newest";
  limit?: number;
};

/** Text a block contributes to the index — including what its tool actually did. */
function indexText(block: Block): string {
  const parts = [block.text];
  const detail = block.tool?.detail;
  if (detail) {
    if (detail.kind === "command") parts.push(detail.command, detail.output ?? "");
    if (detail.kind === "file") parts.push(detail.path, detail.preview ?? "");
    if (detail.kind === "edit") parts.push(detail.path);
    if (detail.kind === "search") parts.push(detail.query);
    if (detail.kind === "fetch") parts.push(detail.url, detail.title ?? "");
    if (detail.kind === "message") parts.push(detail.text);
    if (detail.kind === "output") parts.push(detail.text);
  }
  if (block.fromAgent) parts.push(block.fromAgent.name);
  return parts.filter(Boolean).join("\n");
}

/** One line of context around the match, with the match wrapped in marks. */
function snippetFor(text: string, at: number, length: number): string {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const lineEndRaw = text.indexOf("\n", at);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);
  const offset = at - lineStart;
  const WINDOW = 110;
  let start = Math.max(0, offset - WINDOW / 2);
  let end = Math.min(line.length, start + WINDOW);
  start = Math.max(0, Math.min(start, end - WINDOW));
  const head = start > 0 ? "…" : "";
  const tail = end < line.length ? "…" : "";
  const before = line.slice(start, offset);
  const hit = line.slice(offset, offset + length);
  const after = line.slice(offset + length, end);
  return `${head}${before}${MARK_OPEN}${hit}${MARK_CLOSE}${after}${tail}`;
}

/**
 * Local stand-in for the daemon's FTS5 search. Case-insensitive substring match
 * over every block of every thread, scored by where the hit landed.
 */
export function searchMessages(input: SearchQuery): SearchHit[] {
  const needle = input.query.trim().toLowerCase();
  if (!needle) return [];
  const only = input.sessionIds && input.sessionIds.length > 0 ? new Set(input.sessionIds) : null;
  const scored: Array<{ hit: SearchHit; score: number }> = [];

  for (const [sessionId, blocks] of Object.entries(threads)) {
    if (only && !only.has(sessionId)) continue;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) continue;
    blocks.forEach((block, pos) => {
      const at = block.at ?? 0;
      if (input.from !== undefined && at < input.from) return;
      if (input.to !== undefined && at > input.to) return;
      const text = indexText(block);
      const found = text.toLowerCase().indexOf(needle);
      if (found < 0) return;
      // Prose outranks tool output; an early hit outranks a late one.
      const roleBoost = block.role === "assistant" || block.role === "user" ? 2 : 1;
      scored.push({
        score: roleBoost * 1000 - Math.min(found, 900),
        hit: {
          sessionId,
          sessionName: session.name,
          pos,
          id: block.id,
          role: block.role,
          at,
          snippet: snippetFor(text, found, needle.length),
        },
      });
    });
  }

  scored.sort((a, b) =>
    input.sort === "newest" ? b.hit.at - a.hit.at : b.score - a.score || b.hit.at - a.hit.at,
  );
  return scored.slice(0, input.limit ?? 101).map((entry) => entry.hit);
}
