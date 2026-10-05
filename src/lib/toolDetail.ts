import { botLabel } from "./botNames";
import type { Block, TodoItem, ToolDetail } from "./protocol";

export type { ToolDetail };

/** The collapsed row: one line, and whether it reads as code. */
export type ToolLine = {
  text: string;
  /** Commands and paths are monospace; prose is not. */
  mono: boolean;
  /** Dim trailer: a line range, a diff tally, a match count. */
  suffix?: string | undefined;
  failed?: boolean | undefined;
};

export function detailOf(block: Block): ToolDetail | undefined {
  return block.tool?.detail;
}

/** `/home/me/crew/src/App.tsx` reads as `src/App.tsx` once you know the repo. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path.replace(/^\//, "") : parts.slice(-3).join("/");
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `mcp__chrome-devtools__take_snapshot` reads as `chrome-devtools · take
 * snapshot`. The daemon already titles new calls this way; transcripts from
 * before it did still carry the raw name.
 */
export function mcpLabel(server: string, tool: string): string {
  const host = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
  return `${host} · ${tool.replace(/[_-]/g, " ")}`;
}

export function prettyTitle(title: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title);
  return mcp ? mcpLabel(mcp[1]!, mcp[2]!) : title;
}

export function todoTally(items: TodoItem[]): string {
  const done = items.filter((item) => item.status === "completed").length;
  return `${done}/${items.length} done`;
}

/**
 * What the row says when folded. Falls back to the provider's own title when a
 * tool carries no detail, which keeps every pre-detail transcript readable.
 */
export function toolLine(block: Block): ToolLine {
  const detail = detailOf(block);
  const failed = block.tool?.status === "failed";
  const title = prettyTitle(block.tool?.title ?? block.text);
  if (!detail) return { text: title, mono: false, failed };

  switch (detail.kind) {
    case "command": {
      const failedRun = failed || (detail.exitCode !== undefined && detail.exitCode !== 0);
      return {
        text: firstLine(detail.command),
        mono: true,
        suffix: failedRun && detail.exitCode !== undefined ? `exit ${detail.exitCode}` : undefined,
        failed: failedRun,
      };
    }
    case "file": {
      const range =
        detail.lineStart !== undefined && detail.lineEnd !== undefined
          ? `${detail.lineStart}–${detail.lineEnd}`
          : undefined;
      return { text: shortPath(detail.path), mono: true, suffix: range, failed };
    }
    case "edit": {
      // Show what the provider counted and nothing else: "+0 −0" would read as
      // a write that changed nothing, and a write does not know what it replaced.
      const parts = [
        detail.added === undefined ? null : `+${detail.added}`,
        detail.removed === undefined ? null : `−${detail.removed}`,
      ].filter((part): part is string => part !== null);
      return {
        text: shortPath(detail.path),
        mono: true,
        suffix: parts.length > 0 ? parts.join(" ") : undefined,
        failed,
      };
    }
    case "search":
      return {
        text: detail.query,
        mono: true,
        suffix: detail.matches === undefined ? undefined : matchLabel(detail.matches),
        failed,
      };
    case "fetch":
      return { text: detail.title ?? host(detail.url), mono: false, suffix: host(detail.url), failed };
    case "message":
      return { text: firstLine(detail.text), mono: false, suffix: `to ${botLabel(detail.to)}`, failed };
    case "todo": {
      // What the agent is on now says more than the word "todos" does.
      const current = detail.items.find((item) => item.status === "inProgress");
      return { text: current?.text ?? "Todos", mono: false, suffix: todoTally(detail.items), failed };
    }
    case "agent":
      return { text: detail.description, mono: false, suffix: detail.agentType, failed };
    case "mcp":
      return { text: mcpLabel(detail.server, detail.tool), mono: false, failed };
    case "plan":
      return { text: "Plan", mono: false, suffix: undefined, failed };
    // The result is the body, never the line: a JSON answer's first line is `[`.
    case "output":
      return { text: title, mono: false, failed };
  }
}

function matchLabel(matches: number): string {
  return matches === 1 ? "1 match" : `${matches} matches`;
}

function filled(text: string | undefined): boolean {
  return Boolean(text?.trim());
}

/**
 * Whether opening the row shows anything the folded line did not. A row with
 * nothing behind it gets no chevron and no hit target.
 */
export function hasBody(block: Block): boolean {
  const detail = detailOf(block);
  if (!detail) return false;
  switch (detail.kind) {
    case "command":
      return filled(detail.output) || detail.command.includes("\n");
    case "file":
      return filled(detail.preview);
    case "edit":
      return (detail.hunks?.length ?? 0) > 0;
    case "search":
    case "fetch":
      return filled(detail.output);
    // Both sides trimmed: an indented single line is still a single line, and
    // opening the row would show exactly what the row already shows.
    case "message":
      return detail.text.trim() !== firstLine(detail.text).trim();
    case "todo":
      return detail.items.length > 0;
    case "agent":
      return filled(detail.prompt) || filled(detail.output);
    case "mcp":
      return filled(detail.input) || filled(detail.output);
    case "plan":
    case "output":
      return filled(detail.text);
  }
}

/** What kind of glyph a row wears, read off the detail rather than the name. */
export type ToolGlyphKind = Exclude<ToolDetail["kind"], "output"> | null;

export function glyphKind(block: Block): ToolGlyphKind {
  const kind = detailOf(block)?.kind;
  return kind === undefined || kind === "output" ? null : kind;
}

/** The clip marker the daemon appends when a payload was cut. */
const CLIPPED = /\n… (\d+) more bytes$/;

/** Body text split from the "… N more bytes" trailer the daemon may have added. */
export function splitClip(text: string): { body: string; dropped: number | null } {
  const match = CLIPPED.exec(text);
  if (!match) return { body: text, dropped: null };
  return { body: text.slice(0, match.index), dropped: Number(match[1]) };
}

/** How many lines a tool's output shows before it folds the rest. */
export const FOLD_LINES = 24;

/**
 * The lines a long payload shows until it is asked for the rest. A payload
 * that is only a few lines over shows whole: a button that reveals three
 * lines costs more than the lines do.
 */
export function foldLines(text: string, max = FOLD_LINES): { head: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max + 4) return { head: text, hidden: 0 };
  return { head: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

/** A result that is JSON, laid out to be read; anything else is `null`. */
export function asJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/** A path's extension as the highlighter's language, when it has one. */
export function langProp(path: string): { lang?: string } {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { lang: name.slice(dot + 1) } : {};
}
