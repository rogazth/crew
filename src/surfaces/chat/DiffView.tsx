import { FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { memo, useMemo } from "react";
import { fenceDiffs, snippetFile, type FenceParsers } from "../../lib/diffView";
import { THEME } from "../../lib/highlighting";

const DIFF_OPTIONS = {
  theme: THEME,
  themeType: "light" as const,
  disableFileHeader: true,
  diffStyle: "unified" as const,
  overflow: "scroll" as const,
};

/** Before and after of one file, as the unified diff between them. */
export function Diff({ name, before, after }: { name: string; before: string; after: string }) {
  const fileDiff = useMemo(() => parseDiffFromFile(snippetFile(name, before), snippetFile(name, after)), [name, before, after]);
  return <FileDiff fileDiff={fileDiff} options={DIFF_OPTIONS} disableWorkerPool className="crew-diff" />;
}

const PARSERS: FenceParsers<FileDiffMetadata> = {
  patch: (code) => parsePatchFiles(code).flatMap((patch) => patch.files),
  sides: (before, after) => parseDiffFromFile(snippetFile("before", before), snippetFile("after", after)),
};

/** The body of a ```diff fence: a real patch as is, otherwise the +/- lines rebuilt. */
export const DiffFence = memo(function DiffFence({ code }: { code: string }) {
  const files = useMemo(() => fenceDiffs(code, PARSERS), [code]);
  return (
    <>
      {files.map((fileDiff) => (
        <FileDiff key={fileDiff.name} fileDiff={fileDiff} options={DIFF_OPTIONS} disableWorkerPool className="crew-diff" />
      ))}
    </>
  );
});
