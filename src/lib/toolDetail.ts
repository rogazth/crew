import { agentLabel } from "./agentNames";
import type { Block, ToolDetail } from "./protocol";

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
 * What the row says when folded. Falls back to the provider's own title when a
 * tool carries no detail, which keeps every pre-detail transcript readable.
 */
export function toolLine(block: Block): ToolLine {
  const detail = detailOf(block);
  const failed = block.tool?.status === "failed";
  const title = block.tool?.title ?? block.text;
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
      return { text: firstLine(detail.text), mono: false, suffix: `to ${agentLabel(detail.to)}`, failed };
    case "output":
      return { text: firstLine(detail.text), mono: false, failed };
  }
}

function matchLabel(matches: number): string {
  return matches === 1 ? "1 match" : `${matches} matches`;
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
      return Boolean(detail.output?.trim()) || detail.command.includes("\n");
    case "file":
      return Boolean(detail.preview?.trim());
    // Both sides trimmed: an indented single line is still a single line, and
    // opening the row would show exactly what the row already shows.
    case "message":
      return detail.text.trim() !== firstLine(detail.text).trim();
    case "output":
      return detail.text.trim() !== firstLine(detail.text).trim();
    default:
      return false;
  }
}

/** What kind of glyph a row wears, read off the detail rather than the name. */
export type ToolGlyphKind = "command" | "file" | "edit" | "search" | "fetch" | "message" | null;

export function glyphKind(block: Block): ToolGlyphKind {
  const detail = detailOf(block);
  switch (detail?.kind) {
    case "command":
    case "file":
    case "edit":
    case "search":
    case "fetch":
    case "message":
      return detail.kind;
    default:
      return null;
  }
}

/** The clip marker the daemon appends when a payload was cut. */
const CLIPPED = /\n… (\d+) more bytes$/;

/** Body text split from the "… N more bytes" trailer the daemon may have added. */
export function splitClip(text: string): { body: string; dropped: number | null } {
  const match = CLIPPED.exec(text);
  if (!match) return { body: text, dropped: null };
  return { body: text.slice(0, match.index), dropped: Number(match[1]) };
}
