import clsx from "clsx";
import { useRef } from "react";

export type Chunk = { id: number; text: string };

let seq = 0;

/**
 * Splits a streaming body into the part that is safe to parse as markdown and
 * the line still being typed.
 *
 * Every completed line becomes real markdown immediately, so a list is a list
 * while it grows; only the partial last line is plain. An open fence is closed
 * with a synthetic ``` so code highlights while it arrives.
 */
export function splitStream(text: string): { head: string; tail: string } {
  let depth = 0;
  let lastBreak = -1;
  let at = 0;
  for (const line of text.split("\n")) {
    const end = at + line.length;
    if (/^\s*```/.test(line)) depth = depth === 0 ? 1 : 0;
    if (end < text.length) lastBreak = end;
    at = end + 1;
  }
  if (depth === 1) return { head: `${text}\n\`\`\``, tail: "" };
  if (lastBreak < 0) return { head: "", tail: text };
  return { head: text.slice(0, lastBreak + 1), tail: text.slice(lastBreak + 1) };
}

/**
 * Word-by-word fade. Each delta becomes one span that fades in once; the spans
 * already on screen keep their identity, so nothing re-animates. The fade
 * length tracks how fast tokens are arriving — fast tokens, short fades.
 */
export function StreamText({ text, className }: { text: string; className?: string }) {
  const held = useRef<{ full: string; chunks: Chunk[]; at: number; fade: number }>({
    full: "",
    chunks: [],
    at: 0,
    fade: 220,
  });

  // Idempotent for a repeated render with the same text, which is what makes it
  // safe to compute during render (and therefore safe under StrictMode).
  if (held.current.full !== text) {
    const now = performance.now();
    const since = held.current.at ? now - held.current.at : 220;
    const fade = Math.round(Math.max(90, Math.min(420, since * 3)));
    if (text.startsWith(held.current.full) && held.current.full) {
      held.current = {
        full: text,
        chunks: [...held.current.chunks, { id: (seq += 1), text: text.slice(held.current.full.length) }],
        at: now,
        fade,
      };
    } else {
      held.current = { full: text, chunks: [{ id: (seq += 1), text }], at: now, fade };
    }
  }

  return (
    <span className={clsx("whitespace-pre-wrap", className)}>
      {held.current.chunks.map((chunk) => (
        <span
          key={chunk.id}
          className="fade-word"
          style={{ ["--fade" as string]: `${held.current.fade}ms` }}
        >
          {chunk.text}
        </span>
      ))}
    </span>
  );
}

/** The gap between send and first token. Not a spinner: a line that says so. */
export function Thinking() {
  return (
    <span className="flex items-center gap-2 text-md text-ink-3">
      <span className="caret" />
      <span>Thinking</span>
    </span>
  );
}
