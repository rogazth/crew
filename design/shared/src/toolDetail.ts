import { crewToolLine } from "./crewTools";
import type { Block, ToolDetail } from "./types";

/** The collapsed row: one line, and whether it reads as code. */
export type ToolLine = {
  text: string;
  /** Commands and paths are monospace; prose is not. */
  mono: boolean;
  /** Dim trailer: a line range, a diff tally, a match count. */
  suffix?: string;
  failed?: boolean;
};

export function detailOf(block: Block): ToolDetail | undefined {
  return block.tool?.detail;
}

/** `/Users/me/crew/src/App.tsx` reads as `src/App.tsx` once you know the repo. */
export function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path.replace(/^\//, "") : parts.slice(-3).join("/");
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

export function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Turns a raw tool name into something a human reads: `message_agent` → "message agent". */
function humanName(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced || "a tool";
}

/**
 * What the row says when folded.
 *
 * FIXED vs the app: a provider that sends no `detail` and no readable title used
 * to leak its raw JSON input, which is how a row reading `{` reached the screen.
 * Every row now produces a sentence.
 */
export function toolLine(block: Block, resolveAgent?: (id: string) => string): ToolLine {
  const detail = detailOf(block);
  const failed = block.tool?.status === "failed";
  const raw = (block.tool?.title ?? block.text ?? "").trim();
  const readable = raw && !raw.startsWith("{") && !raw.startsWith("[") ? raw : null;

  // Crew's own tools are the calls most worth reading and the ones the app
  // renders worst: they arrive as `output` with a JSON blob, or with no detail
  // at all. Measured against a real daemon — see design/FINDINGS.md.
  //
  // Only when the detail is missing or useless, though. A `message_agent` the
  // adapter *did* normalise carries the letter's text, which beats anything
  // recoverable from the call's name.
  if (!detail || detail.kind === "output") {
    const crew = crewToolLine(block.tool?.name ?? "", block.tool?.args, resolveAgent, {
      ...(block.tool?.title ? { title: block.tool.title } : {}),
      ...(detail?.kind === "output" ? { output: detail.text } : {}),
    });
    if (crew) {
      const line: ToolLine = { text: crew.text, mono: false, failed };
      if (crew.suffix) line.suffix = crew.suffix;
      return line;
    }
  }

  if (!detail) {
    return { text: readable ?? `Used ${humanName(block.tool?.name ?? "")}`, mono: false, failed };
  }

  switch (detail.kind) {
    case "command": {
      const failedRun = failed || (detail.exitCode !== undefined && detail.exitCode !== 0);
      const out: ToolLine = { text: firstLine(detail.command), mono: true, failed: failedRun };
      if (failedRun && detail.exitCode !== undefined) out.suffix = `exit ${detail.exitCode}`;
      return out;
    }
    case "file": {
      const out: ToolLine = { text: shortPath(detail.path), mono: true, failed };
      if (detail.lineStart !== undefined && detail.lineEnd !== undefined) {
        out.suffix = `${detail.lineStart}–${detail.lineEnd}`;
      }
      return out;
    }
    case "edit": {
      const out: ToolLine = { text: shortPath(detail.path), mono: true, failed };
      const tally = [
        detail.added ? `+${detail.added}` : null,
        detail.removed ? `−${detail.removed}` : null,
      ].filter(Boolean);
      if (tally.length) out.suffix = tally.join(" ");
      return out;
    }
    case "search": {
      const out: ToolLine = { text: detail.query, mono: true, failed };
      if (detail.matches !== undefined) {
        out.suffix = detail.matches === 1 ? "1 match" : `${detail.matches} matches`;
      }
      return out;
    }
    case "fetch":
      return { text: detail.title ?? host(detail.url), mono: false, failed, suffix: host(detail.url) };
    case "message":
      return { text: firstLine(detail.text), mono: false, failed };
    case "output":
      return { text: readable ?? firstLine(detail.text), mono: false, failed };
  }
}

/** Which glyph the row wears: what it did, not what its phase was called. */
export function glyphKind(block: Block): ToolDetail["kind"] | null {
  return detailOf(block)?.kind ?? null;
}

/** Only rows that carry something worth a box offer to open. */
export function hasBody(block: Block): boolean {
  const detail = detailOf(block);
  if (!detail) {
    return Boolean(
      crewToolLine(block.tool?.name ?? "", block.tool?.args, undefined, {
        ...(block.tool?.title ? { title: block.tool.title } : {}),
      })?.body,
    );
  }
  if (detail.kind === "command") return Boolean(detail.output?.trim() || detail.command.includes("\n"));
  if (detail.kind === "file") return Boolean(detail.preview?.trim());
  if (detail.kind === "edit") return Boolean(detail.diff?.trim());
  if (detail.kind === "message") return true;
  if (detail.kind === "output") return Boolean(detail.text.trim());
  return false;
}

const CLIP = 8_000;

/** Long output is cut; the row says how much it dropped. */
export function splitClip(text: string): { body: string; dropped: number | null } {
  if (text.length <= CLIP) return { body: text, dropped: null };
  return { body: text.slice(0, CLIP), dropped: text.length - CLIP };
}

export function isOpen(block: Block): boolean {
  if (block.role === "tool") return block.tool?.status === "pending";
  if (block.role === "approval") return block.approval != null && !block.approval.decided;
  if (block.role === "question") {
    return block.question != null && !block.question.answers && !block.question.dismissed;
  }
  return false;
}
