import type { LineMatch } from "./protocol";

export type Run = { text: string; hit: boolean };

/**
 * A result's preview split into plain and matched runs. The daemon's ranges
 * count in the whole line, and the preview is a window of it from `previewStart`.
 */
export function previewRuns(line: LineMatch): Run[] {
  const runs: Run[] = [];
  const { preview } = line;
  let at = 0;
  for (const [from, to] of line.ranges) {
    const start = Math.max(at, Math.min(preview.length, from - line.previewStart));
    const end = Math.max(start, Math.min(preview.length, to - line.previewStart));
    if (end === start) continue;
    if (start > at) runs.push({ text: preview.slice(at, start), hit: false });
    runs.push({ text: preview.slice(start, end), hit: true });
    at = end;
  }
  if (at < preview.length) runs.push({ text: preview.slice(at), hit: false });
  return runs;
}
