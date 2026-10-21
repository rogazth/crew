// Simple formatting while typing in the composer: lists that carry on and indent. Not a markdown
// editor — the text stays plain markdown, and every change is one edit of the draft's text.

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
  // A selection that runs past the line, or a caret inside the marker itself, is left to the editor.
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

/**
 * Backspace with the caret right after a list marker takes the whole marker at once, as an editor
 * would: an empty item goes with the line break before it (the caret lands at the end of the line
 * above), and an item with text keeps its text as a plain line. Null anywhere else.
 */
export function removeListMarker(text: string, selStart: number, selEnd: number = selStart): TextEdit | null {
  if (selStart !== selEnd) return null;
  const item = listItemAt(text, selStart);
  if (!item || selStart !== item.contentStart) return null;
  const empty = text.slice(item.contentStart, item.lineEnd).trim() === "";
  if (empty && item.lineStart > 0) {
    const at = item.lineStart - 1;
    return { start: at, end: item.lineEnd, insert: "", selStart: at, selEnd: at };
  }
  return { start: item.lineStart, end: item.contentStart, insert: "", selStart: item.lineStart, selEnd: item.lineStart };
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
