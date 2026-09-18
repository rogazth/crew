export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type DiffHunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string | null; hunks: DiffHunk[]; added: number; removed: number };

const HUNK = /^@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@(.*)$/;

/**
 * Parses a unified patch, tolerating the two shapes the app actually sees: a
 * real `git diff` with file headers, and a bare ```diff fence with no `@@` at
 * all. Line numbers are synthesised in the second case so the gutter still
 * counts.
 */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 1;
  let newNo = 1;

  const ensureFile = (path: string | null) => {
    if (file && file.path === path) return file;
    file = { path, hunks: [], added: 0, removed: 0 };
    files.push(file);
    hunk = null;
    return file;
  };
  const ensureHunk = (header: string) => {
    const target = file ?? ensureFile(null);
    hunk = { header, lines: [] };
    target.hunks.push(hunk);
    return hunk;
  };

  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("diff --git")) {
      const path = raw.split(" ").pop()?.replace(/^b\//, "") ?? null;
      ensureFile(path);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("new file")) continue;
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).replace(/^b\//, "").trim();
      if (path && path !== "/dev/null") ensureFile(path);
      continue;
    }
    const hunkMatch = HUNK.exec(raw);
    if (hunkMatch) {
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[2]);
      const h = ensureHunk(hunkMatch[3]?.trim() ?? "");
      h.lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
      continue;
    }
    const target = file ?? ensureFile(null);
    const current = hunk ?? ensureHunk("");
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      target.added += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      target.removed += 1;
    } else if (raw.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      current.lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** Pairs removals with additions so a side-by-side view lines up. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "ctx" || line.kind === "hunk" || line.kind === "meta") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    const span = Math.max(dels.length, adds.length);
    for (let j = 0; j < span; j += 1) {
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return rows;
}

export function diffTally(files: DiffFile[]): { added: number; removed: number } {
  return files.reduce(
    (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
    { added: 0, removed: 0 },
  );
}
