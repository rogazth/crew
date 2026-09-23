import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { memo, useMemo } from "react";
import { THEME } from "../../lib/highlighting";

const DIFF_OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  diffStyle: "unified" as const,
  overflow: "scroll" as const,
};

/** A snippet is not a file; without the trailing newline every hunk warns about it. */
function file(name: string, contents: string) {
  return contents ? { name, contents: contents.endsWith("\n") ? contents : `${contents}\n` } : null;
}

/** Before and after of one file, as the unified diff between them. */
export function Diff({ name, before, after }: { name: string; before: string; after: string }) {
  const fileDiff = useMemo(() => parseDiffFromFile(file(name, before), file(name, after)), [name, before, after]);
  return <FileDiff fileDiff={fileDiff} options={DIFF_OPTIONS} disableWorkerPool className="crew-diff" />;
}

const HUNK = /^@@ /m;

/** Bare +/- lines have no file to diff, so they are rebuilt into a before and an after. */
function fromFence(code: string): FileDiffMetadata[] {
  if (HUNK.test(code)) {
    try {
      const files = parsePatchFiles(code).flatMap((patch) => patch.files);
      if (files.length > 0) return files;
    } catch {
      /* not a patch after all; fall through to the line walk */
    }
  }
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
  return [parseDiffFromFile(file("before", before.join("\n")), file("after", after.join("\n")))];
}

/** The body of a ```diff fence: a real patch as is, otherwise the +/- lines rebuilt. */
export const DiffFence = memo(function DiffFence({ code }: { code: string }) {
  const files = useMemo(() => fromFence(code), [code]);
  return (
    <>
      {files.map((fileDiff) => (
        <FileDiff key={fileDiff.name} fileDiff={fileDiff} options={DIFF_OPTIONS} disableWorkerPool className="crew-diff" />
      ))}
    </>
  );
});
