import { useMemo, useState } from "react";
import { diffs } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { HighlightedLine, langFromPath, type Lang } from "@/lib/highlight";
import { useStore } from "@/lib/store";
import { Icon } from "@/ui/Icon";
import { Segmented } from "@/ui/Segmented";
import { Badge } from "@/ui/Badge";

export type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number }
  | { kind: "meta"; text: string };

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo = Number(match?.[1] ?? 1);
      newNo = Number(match?.[2] ?? 1);
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
      continue;
    }
    out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}

export function tallyPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

const GUTTER = "w-9 shrink-0 select-none pr-2 text-right text-[var(--ink-38)] tabular-nums";

export function Diff({
  patch,
  lang = "ts",
  view = "unified",
  className,
}: {
  patch: string;
  lang?: Lang;
  view?: "unified" | "split";
  className?: string;
}) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  if (view === "split") return <SplitDiff lines={lines} lang={lang} className={className} />;

  return (
    <div className={cx("scroller overflow-x-auto font-mono text-code", className)}>
      {lines.map((line, index) => (
        <div
          key={index}
          className={cx(
            "flex min-w-max items-start gap-0 px-2",
            line.kind === "add" && "bg-added-bg",
            line.kind === "del" && "bg-removed-bg",
            line.kind === "hunk" && "bg-sunken",
          )}
        >
          {line.kind === "hunk" ? (
            <span className="py-1 text-ink-38">{line.text}</span>
          ) : line.kind === "meta" ? (
            <span className="py-0.5 text-ink-38">{line.text}</span>
          ) : (
            <>
              <span className={GUTTER}>{line.kind === "add" ? "" : line.oldNo}</span>
              <span className={GUTTER}>{line.kind === "del" ? "" : line.newNo}</span>
              <span
                className={cx(
                  "w-4 shrink-0 select-none text-center",
                  line.kind === "add" ? "text-[var(--added-ink)]" : line.kind === "del" ? "text-[var(--removed-ink)]" : "text-ink-38",
                )}
              >
                {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
              </span>
              <span className="whitespace-pre text-code-ink">
                <HighlightedLine line={line.text} lang={lang} />
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function SplitDiff({ lines, lang, className }: { lines: DiffLine[]; lang: Lang; className?: string }) {
  const rows: Array<{ left?: DiffLine; right?: DiffLine; hunk?: string }> = [];
  let pending: DiffLine[] = [];

  const flush = () => {
    const dels = pending.filter((l) => l.kind === "del");
    const adds = pending.filter((l) => l.kind === "add");
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      const row: { left?: DiffLine; right?: DiffLine } = {};
      if (dels[i]) row.left = dels[i];
      if (adds[i]) row.right = adds[i];
      rows.push(row);
    }
    pending = [];
  };

  for (const line of lines) {
    if (line.kind === "add" || line.kind === "del") {
      pending.push(line);
      continue;
    }
    flush();
    if (line.kind === "hunk") rows.push({ hunk: line.text });
    else if (line.kind === "ctx") rows.push({ left: line, right: line });
  }
  flush();

  const cell = (line: DiffLine | undefined, side: "left" | "right") => (
    <div
      className={cx(
        "flex min-w-0 flex-1 items-start gap-0 px-2",
        line?.kind === "add" && "bg-added-bg",
        line?.kind === "del" && "bg-removed-bg",
        !line && "bg-sunken",
      )}
    >
      <span className={GUTTER}>
        {line && line.kind !== "hunk" && line.kind !== "meta"
          ? side === "left"
            ? "oldNo" in line
              ? line.oldNo
              : ""
            : "newNo" in line
              ? line.newNo
              : ""
          : ""}
      </span>
      <span className="min-w-0 whitespace-pre text-code-ink">
        {line && line.kind !== "hunk" && line.kind !== "meta" ? (
          <HighlightedLine line={line.text} lang={lang} />
        ) : null}
      </span>
    </div>
  );

  return (
    <div className={cx("scroller overflow-x-auto font-mono text-code", className)}>
      {rows.map((row, index) =>
        row.hunk ? (
          <div key={index} className="bg-sunken px-2 py-1 text-ink-38">
            {row.hunk}
          </div>
        ) : (
          <div key={index} className="flex min-w-max">
            <div className="flex w-1/2 min-w-[320px] border-r border-[var(--line-soft)]">{cell(row.left, "left")}</div>
            <div className="flex w-1/2 min-w-[320px]">{cell(row.right, "right")}</div>
          </div>
        ),
      )}
    </div>
  );
}

/** The drawer's third content: a diff preview with its own view control. */
export function DiffPanel({ path }: { path: string }) {
  const { setDrawer, openFile } = useStore();
  const [view, setView] = useState<"unified" | "split">("unified");
  const fixture = diffs.find((entry) => entry.path === path) ?? diffs[0]!;
  const tally = tallyPatch(fixture.patch);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-soft)] px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-control bg-sunken text-ink-52">
          <Icon name="split" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm text-ink">{fixture.path}</p>
          <p className="flex items-center gap-2 text-xs text-ink-52">
            <span className="text-[var(--added-ink)]">+{tally.added}</span>
            <span className="text-[var(--removed-ink)]">−{tally.removed}</span>
          </p>
        </div>
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "unified", label: "Unified" },
            { value: "split", label: "Split" },
          ]}
        />
        <button
          type="button"
          onClick={() => setDrawer(null)}
          aria-label="Close"
          className="rise-1 grid size-7 shrink-0 place-items-center rounded-chip text-ink-52 hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto scroller py-2">
        <Diff patch={fixture.patch} lang={langFromPath(fixture.path)} view={view} />
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--line-soft)] px-4 py-2.5">
        <Badge tone="accent">preview</Badge>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setDrawer(null);
            openFile(fixture.path);
          }}
          className="rise-1 flex h-7 items-center gap-1.5 rounded-chip px-2 text-sm text-ink-70 hover:bg-sunken hover:text-ink"
        >
          <Icon name="arrowUpRight" size={13} />
          Open file
        </button>
      </footer>
    </div>
  );
}
