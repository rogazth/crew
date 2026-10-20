// Simple formatting while typing in the composer: lists that carry on and indent. Not a markdown
// editor — the text stays plain markdown, and every change is one edit of the textarea's text.

/** One replacement of the text: `[start, end)` becomes `insert`, then the selection is `[selStart, selEnd]`. */
export interface TextEdit {
  start: number;
  end: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

export interface ListItem {
  /** Where the line starts in the text. */
  lineStart: number;
  /** Where the line ends (before its `\n`, or the text's end). */
  lineEnd: number;
  /** Leading spaces or tabs. */
  indent: string;
  /** `-`, `*`, `+`, or a number with its `.` or `)`. */
  marker: string;
  /** The spaces after the marker, and a task box `[ ] ` if there is one. */
  gap: string;
  /** Where the item's own text begins in the text. */
  contentStart: number;
}

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])( +(?:\[[ xX]\] )?)/;

function lineBounds(text: string, at: number): { lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const newline = text.indexOf("\n", at);
  return { lineStart, lineEnd: newline === -1 ? text.length : newline };
}

/** The list item on the line that holds `at`, or null if that line is no list item. */
export function listItemAt(text: string, at: number): ListItem | null {
  const { lineStart, lineEnd } = lineBounds(text, at);
  const line = text.slice(lineStart, lineEnd);
  const match = ITEM.exec(line);
  if (!match) return null;
  const [whole, indent, marker, gap] = match as unknown as [string, string, string, string];
  return { lineStart, lineEnd, indent, marker, gap, contentStart: lineStart + whole.length };
}

function nextMarker(marker: string): string {
  const numbered = /^(\d+)([.)])$/.exec(marker);
  if (!numbered) return marker;
  return `${Number(numbered[1]) + 1}${numbered[2]}`;
}

/**
 * What a new line does on a list item: carries the list on with the same marker and indent (a number
 * goes up by one, a task box starts unticked), or on an empty item ends the list by taking the marker
 * away. Null when the caret is not in a list item's text, so the new line is an ordinary one.
 */
export function continueList(text: string, selStart: number, selEnd: number = selStart): TextEdit | null {
  const item = listItemAt(text, selStart);
  if (!item) return null;
  // A selection that runs past the line, or a caret inside the marker itself, is left to the textarea.
  if (selEnd > item.lineEnd || selStart < item.contentStart) return null;
  const content = text.slice(item.contentStart, item.lineEnd);
  if (content.trim() === "" && selStart === selEnd) {
    // An empty item ends the list: the marker goes and the line is left empty.
    return { start: item.lineStart, end: item.lineEnd, insert: "", selStart: item.lineStart, selEnd: item.lineStart };
  }
  const gap = item.gap.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${item.indent}${nextMarker(item.marker)}${gap}`;
  const caret = selStart + insert.length;
  return { start: selStart, end: selEnd, insert, selStart: caret, selEnd: caret };
}

export const INDENT = "  ";

/** How much of a line's leading whitespace one outdent takes: one tab, or up to two spaces. */
function outdentWidth(indent: string): number {
  if (indent.startsWith("\t")) return 1;
  let width = 0;
  while (width < INDENT.length && indent[width] === " ") width++;
  return width;
}

/**
 * Tab or ⇧Tab on list items: every list line the selection touches moves in or out by two spaces (or
 * one tab out), as one edit. Null when no line there is a list item, or on ⇧Tab when none of them is
 * indented, so the key keeps doing what it does elsewhere.
 */
export function indentList(text: string, selStart: number, selEnd: number, direction: 1 | -1): TextEdit | null {
  const first = lineBounds(text, selStart).lineStart;
  // A selection that ends at the very start of a line does not take that line in.
  const lastAt = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const last = lineBounds(text, lastAt).lineEnd;
  // Each changed line: where it starts in the original text, and how many characters go in (+) or out (-) there.
  const changes: { at: number; delta: number }[] = [];
  let offset = first;
  const out = text
    .slice(first, last)
    .split("\n")
    .map((line) => {
      const lineStart = offset;
      offset += line.length + 1;
      const match = ITEM.exec(line);
      if (!match) return line;
      if (direction === 1) {
        changes.push({ at: lineStart, delta: INDENT.length });
        return INDENT + line;
      }
      const width = outdentWidth(match[1] ?? "");
      if (width === 0) return line;
      changes.push({ at: lineStart, delta: -width });
      return line.slice(width);
    });
  if (changes.length === 0) return null;
  // A position moves with its line; one inside removed indentation lands at the line's start.
  const map = (pos: number) =>
    changes.reduce((moved, { at, delta }) => (pos < at ? moved : moved + (delta > 0 ? delta : -Math.min(-delta, pos - at))), pos);
  return { start: first, end: last, insert: out.join("\n"), selStart: map(selStart), selEnd: map(selEnd) };
}

/** True when the caret's line is a list item: Tab then indents instead of leaving the field. */
export function onListLine(text: string, at: number): boolean {
  return listItemAt(text, at) !== null;
}

/** True when the caret's line is an indented list item: ⇧Tab then outdents instead of cycling access. */
export function onIndentedListLine(text: string, at: number): boolean {
  const item = listItemAt(text, at);
  return item !== null && item.indent.length > 0;
}

const MARKER = /^([ \t]*)([-*+]|\d{1,9}[.)])(?= )/;

/**
 * Splits the overlay's runs further, the list markers at line starts apart, so they can be tinted. Only
 * `text` runs are split; the characters stay exactly the same, so the overlay keeps its alignment.
 */
export function splitListMarkers<T extends { kind: string; text: string }>(
  segments: readonly T[],
): (T | { kind: "marker"; text: string })[] {
  const parts: (T | { kind: "marker"; text: string })[] = [];
  let atLineStart = true;
  for (const segment of segments) {
    if (segment.kind !== "text") {
      parts.push(segment);
      if (segment.text.length > 0) atLineStart = segment.text.endsWith("\n");
      continue;
    }
    const text = segment.text;
    let rest = 0;
    let lineStart: number = atLineStart ? 0 : text.indexOf("\n") + 1;
    // No line starts in this run when it neither begins one nor holds a newline.
    if (!atLineStart && lineStart === 0) lineStart = -1;
    while (lineStart !== -1) {
      const lineEnd = text.indexOf("\n", lineStart);
      const match = MARKER.exec(text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd));
      if (match) {
        const from = lineStart + match[1]!.length;
        const to = from + match[2]!.length;
        if (from > rest) parts.push({ ...segment, text: text.slice(rest, from) });
        parts.push({ kind: "marker", text: text.slice(from, to) });
        rest = to;
      }
      lineStart = lineEnd === -1 ? -1 : lineEnd + 1;
    }
    if (rest < text.length) parts.push({ ...segment, text: text.slice(rest) });
    if (text.length > 0) atLineStart = text.endsWith("\n");
  }
  return parts;
}

const CODE = /`[^`\n]+`/g;

/**
 * Splits the overlay's text runs at inline code: each `` `span` `` becomes its backticks (`tick`) and
 * what is between them (`code`), so the span can be tinted. Like the list markers, every character stays
 * where it was and keeps the field's font, so the overlay never drifts from the textarea.
 */
export function splitInlineCode<T extends { kind: string; text: string }>(
  segments: readonly T[],
): (T | { kind: "tick" | "code"; text: string })[] {
  const parts: (T | { kind: "tick" | "code"; text: string })[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text") {
      parts.push(segment);
      continue;
    }
    let rest = 0;
    for (const match of segment.text.matchAll(CODE)) {
      const at = match.index;
      if (at > rest) parts.push({ ...segment, text: segment.text.slice(rest, at) });
      parts.push({ kind: "tick", text: "`" });
      parts.push({ kind: "code", text: match[0].slice(1, -1) });
      parts.push({ kind: "tick", text: "`" });
      rest = at + match[0].length;
    }
    if (rest < segment.text.length) parts.push({ ...segment, text: segment.text.slice(rest) });
  }
  return parts;
}

/**
 * Applies an edit through the textarea, so the browser's own undo takes it back: the selection is set
 * and the text typed over it. Where the browser will not type, the value is set and an input event sent.
 */
export function applyEdit(el: HTMLTextAreaElement, edit: TextEdit): void {
  el.focus();
  el.setSelectionRange(edit.start, edit.end);
  const typed =
    edit.insert === ""
      ? edit.start === edit.end || document.execCommand("delete", false)
      : document.execCommand("insertText", false, edit.insert);
  if (!typed) {
    const value = el.value.slice(0, edit.start) + edit.insert + el.value.slice(edit.end);
    // React tracks the value it last set: the native setter makes the input event read as a change.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}
