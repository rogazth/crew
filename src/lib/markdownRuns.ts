export type Run = { kind: "prose" | "wide"; text: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const IMAGE_ONLY = /^ {0,3}!\[[^\]]*\]\([^)]*\)\s*$/;
const TABLE_DIVIDER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

function closesFence(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1]![0] === marker[0] && match[1]!.length >= marker.length;
}

/**
 * Splits a message into prose runs and the blocks that need the whole column:
 * fences, quotes, tables, rules and lone images. Works on lines rather than
 * the parser's blocks so a fence inside a list still breaks out. Fences
 * indented four or more spaces stay in the prose, as do lazy quote lines.
 */
export function groupRuns(text: string): Run[] {
  const lines = text.split("\n");
  const runs: Run[] = [];
  let prose: string[] = [];
  const push = (chunk: string[]) => {
    if (chunk.some((line) => line.trim() !== "")) runs.push({ kind: "prose", text: chunk.join("\n") });
  };
  const flush = () => {
    push(prose);
    prose = [];
  };
  // Headings that close a run caption the wide block after it, so they leave the bubble.
  const wide = (from: number, to: number) => {
    let cut = prose.length;
    while (cut > 0 && prose[cut - 1]!.trim() === "") cut--;
    while (cut > 0 && HEADING.test(prose[cut - 1]!)) cut--;
    if (cut < prose.length && prose.slice(0, cut).some((line) => line.trim() !== "")) {
      push(prose.slice(0, cut));
      prose = prose.slice(cut);
    }
    flush();
    runs.push({ kind: "wide", text: lines.slice(from, to).join("\n") });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !closesFence(lines[j]!, fence[1]!)) j++;
      wide(i, Math.min(j + 1, lines.length));
      i = j + 1;
      continue;
    }
    if (QUOTE.test(line)) {
      let j = i + 1;
      while (j < lines.length && QUOTE.test(lines[j]!)) j++;
      wide(i, j);
      i = j;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim() !== "") j++;
      wide(i, j);
      i = j;
      continue;
    }
    // A run of dashes under a text line is a setext heading, not a rule.
    const afterBlank = i === 0 || lines[i - 1]!.trim() === "";
    if (afterBlank && (RULE.test(line) || IMAGE_ONLY.test(line))) {
      wide(i, i + 1);
      i++;
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return runs;
}

/** A run that is only headings labels the wide block after it; it gets no bubble. */
export function isHeadingOnly(text: string): boolean {
  return text.split("\n").every((line) => line.trim() === "" || HEADING.test(line));
}
