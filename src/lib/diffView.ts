export type SnippetFile = { name: string; contents: string };

/** A snippet is not a file; without the trailing newline every hunk warns about it. */
export function snippetFile(name: string, contents: string): SnippetFile | null {
  return contents ? { name, contents: contents.endsWith("\n") ? contents : `${contents}\n` } : null;
}

const HUNK = /^@@ /m;

/** Bare +/- lines rebuilt into the before and after they describe. Context lines go to both. */
export function fenceSides(code: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of code.split("\n")) {
    if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith("-")) before.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      before.push(text);
      after.push(text);
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

export type FenceParsers<T> = {
  /** Every file of a real patch; may throw on text that only looks like one. */
  patch: (code: string) => T[];
  /** The diff between two versions of one file. */
  sides: (before: string, after: string) => T;
};

/** The body of a ```diff fence: a real patch as is, otherwise the +/- lines rebuilt. */
export function fenceDiffs<T>(code: string, parse: FenceParsers<T>): T[] {
  if (HUNK.test(code)) {
    try {
      const files = parse.patch(code);
      if (files.length > 0) return files;
    } catch {
      /* not a patch after all; fall through to the line walk */
    }
  }
  const { before, after } = fenceSides(code);
  return [parse.sides(before, after)];
}
