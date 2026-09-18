import clsx from "clsx";
import { useMemo } from "react";
import { Code } from "./chat/Code";
import { langFromPath, type Lang } from "@/lib/highlight";

export type DiffLine = {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  left: number | null;
  right: number | null;
};

export type Hunk = { header: string; lines: DiffLine[] };

export function parseDiff(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let left = 0;
  let right = 0;

  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (header) {
      left = Number.parseInt(header[1]!, 10);
      right = Number.parseInt(header[2]!, 10);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ )/.test(raw)) {
      if (!current) {
        current = { header: "", lines: [] };
        hunks.push(current);
      }
      current.lines.push({ kind: "meta", text: raw, left: null, right: null });
      continue;
    }
    if (!current) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), left: null, right: right++ });
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), left: left++, right: null });
    } else if (raw.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: raw, left: null, right: null });
    } else {
      current.lines.push({ kind: "ctx", text: raw.slice(1), left: left++, right: right++ });
    }
  }
  return hunks.filter((hunk) => hunk.header || hunk.lines.length > 0);
}

export type DiffViewProps = {
  patch: string;
  path?: string;
  added?: number;
  removed?: number;
  mode?: "unified" | "split";
  /** Chrome-free, for a diff sitting inside a tool row or an approval card. */
  bare?: boolean;
  className?: string;
};

export function DiffView({
  patch,
  path,
  added,
  removed,
  mode = "unified",
  bare,
  className,
}: DiffViewProps) {
  const hunks = useMemo(() => parseDiff(patch), [patch]);
  const lang = path ? langFromPath(path) : "text";

  return (
    <div
      className={clsx(
        "overflow-hidden rounded-[var(--r)] font-mono text-sm",
        bare ? "" : "border border-rule bg-sunken",
        className,
      )}
    >
      {bare ? null : (
        <div className="flex items-center gap-2 border-b border-rule px-2 py-1">
          <span className="truncate text-ink-2">{path ?? "diff"}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
            {added ? <span className="text-green-ink">+{added}</span> : null}
            {removed ? <span className="text-red-ink">−{removed}</span> : null}
          </span>
        </div>
      )}
      <div className="scroll overflow-x-auto">
        {hunks.map((hunk, index) =>
          mode === "split" ? (
            <SplitHunk key={index} hunk={hunk} lang={lang} />
          ) : (
            <UnifiedHunk key={index} hunk={hunk} lang={lang} />
          ),
        )}
      </div>
    </div>
  );
}

const TINT: Record<DiffLine["kind"], string> = {
  add: "bg-add-bg",
  del: "bg-del-bg",
  ctx: "",
  meta: "",
};

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " ", meta: " " };

function UnifiedHunk({ hunk, lang }: { hunk: Hunk; lang: Lang }) {
  return (
    <div>
      {hunk.header ? (
        <div className="border-y border-rule bg-raised px-2 py-0.5 text-xs text-ink-4 first:border-t-0">
          {hunk.header}
        </div>
      ) : null}
      {hunk.lines.map((line, index) => (
        <div key={index} className={clsx("flex items-start", TINT[line.kind])}>
          <span className="w-10 shrink-0 pr-2 text-right text-xs text-ink-4 select-none">
            {line.left ?? ""}
          </span>
          <span className="w-10 shrink-0 pr-2 text-right text-xs text-ink-4 select-none">
            {line.right ?? ""}
          </span>
          <span
            className={clsx(
              "w-3 shrink-0 select-none",
              line.kind === "add" ? "text-green-ink" : line.kind === "del" ? "text-red-ink" : "text-ink-4",
            )}
          >
            {SIGN[line.kind]}
          </span>
          <span className={clsx("min-w-0 flex-1 pr-3 whitespace-pre", line.kind === "meta" && "text-ink-4")}>
            {line.kind === "meta" ? line.text : <Code text={line.text} lang={lang} />}
          </span>
        </div>
      ))}
    </div>
  );
}

type Pair = { left: DiffLine | null; right: DiffLine | null };

function pairUp(lines: DiffLine[]): Pair[] {
  const out: Pair[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const rows = Math.max(dels.length, adds.length);
    for (let i = 0; i < rows; i += 1) out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.kind === "del") dels.push(line);
    else if (line.kind === "add") adds.push(line);
    else {
      flush();
      out.push({ left: line, right: line });
    }
  }
  flush();
  return out;
}

function SplitHunk({ hunk, lang }: { hunk: Hunk; lang: Lang }) {
  const pairs = pairUp(hunk.lines);
  return (
    <div>
      {hunk.header ? (
        <div className="border-y border-rule bg-raised px-2 py-0.5 text-xs text-ink-4 first:border-t-0">
          {hunk.header}
        </div>
      ) : null}
      {pairs.map((pair, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <SplitCell line={pair.left} side="left" lang={lang} />
          <SplitCell line={pair.right} side="right" lang={lang} />
        </div>
      ))}
    </div>
  );
}

function SplitCell({ line, side, lang }: { line: DiffLine | null; side: "left" | "right"; lang: Lang }) {
  const show = line && (side === "left" ? line.kind !== "add" : line.kind !== "del");
  return (
    <div
      className={clsx(
        // A long line must clip at its own column, never paint over the other.
        "flex min-w-0 items-start overflow-hidden",
        side === "left" && "border-r border-rule",
        show && line ? TINT[line.kind] : "bg-raised/40",
      )}
    >
      <span className="w-10 shrink-0 pr-2 text-right text-xs text-ink-4 select-none">
        {show && line ? (side === "left" ? (line.left ?? "") : (line.right ?? "")) : ""}
      </span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre">
        {show && line ? (
          line.kind === "meta" ? (
            <span className="text-ink-4">{line.text}</span>
          ) : (
            <Code text={line.text} lang={lang} />
          )
        ) : null}
      </span>
    </div>
  );
}
