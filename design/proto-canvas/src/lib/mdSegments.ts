/**
 * Splits a markdown body into prose and widgets.
 *
 * The user liked the message-in-a-bubble / widget-outside-a-bubble split, so it
 * is done here rather than in CSS: prose segments become bubbles, code fences,
 * tables and blockquotes become full-width cards between them.
 */
export type MdSegment =
  | { kind: "prose"; text: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; text: string }
  | { kind: "quote"; text: string };

export function splitMarkdown(source: string): MdSegment[] {
  const lines = source.split("\n");
  const out: MdSegment[] = [];
  let prose: string[] = [];

  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) out.push({ kind: "prose", text });
    prose = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (/^\s*```/.test(line)) {
      flush();
      const lang = line.replace(/^\s*```/, "").trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      out.push({ kind: "code", text: body.join("\n"), lang });
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i -= 1;
      out.push({ kind: "table", text: body.join("\n") });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]!) || (body.length > 0 && lines[i]!.trim() === ""))) {
        if (lines[i]!.trim() === "" && !/^\s*>/.test(lines[i + 1] ?? "")) break;
        body.push(lines[i]!);
        i += 1;
      }
      i -= 1;
      out.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    prose.push(line);
  }
  flush();
  return out;
}

const PATH = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.\w{1,5}$/;

/** Does this inline code span name a file the editor could open? */
export const looksLikePath = (text: string): boolean => PATH.test(text.trim());
