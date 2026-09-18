import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { IconButton, Segmented } from "@/ui";
import { diffTally, parseDiff, splitRows, type DiffFile, type DiffLine } from "@/lib/diff";
import { highlightCached, langOfPath } from "@/lib/highlight";

const ROW = 18;
const TAB = "  ";

type Mode = "unified" | "split";

const CODE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-small)",
  lineHeight: `${ROW}px`,
  letterSpacing: 0,
  fontVariantLigatures: "none",
  whiteSpace: "pre",
  tabSize: 2,
};

/** Row tints. The sign column takes the stronger of the pair so the edge reads. */
const ADD_BG = "var(--diff-add-bg)";
const DEL_BG = "var(--diff-del-bg)";
const ADD_SIGN = "var(--diff-add-gutter)";
const DEL_SIGN = "var(--diff-del-gutter)";
const ADD_HALF = "color-mix(in oklch, var(--diff-add-bg) 50%, transparent)";
const DEL_HALF = "color-mix(in oklch, var(--diff-del-bg) 50%, transparent)";

const bgOf = (kind: DiffLine["kind"]) =>
  kind === "add" ? ADD_BG : kind === "del" ? DEL_BG : undefined;
const signBgOf = (kind: DiffLine["kind"]) =>
  kind === "add" ? ADD_SIGN : kind === "del" ? DEL_SIGN : undefined;
const halfOf = (kind: DiffLine["kind"]) =>
  kind === "add" ? ADD_HALF : kind === "del" ? DEL_HALF : undefined;
const signOf = (kind: DiffLine["kind"]) => (kind === "add" ? "+" : kind === "del" ? "-" : " ");

/**
 * One line at a time. `highlightCached` folds its id from the key, the language
 * and the length, so passing the line text as the key keeps two same-length
 * lines from sharing an entry — and memo keeps the tokenizer off the scroll path.
 */
const CodeSpan = memo(function CodeSpan({ text, lang }: { text: string; lang: string }) {
  const source = text.replace(/\t/g, TAB);
  const tokens = highlightCached(source, source, lang)[0] ?? [];
  return (
    <>
      {tokens.map((token, i) => (
        <span key={i} className={`tok-${token.cls}`}>
          {token.text}
        </span>
      ))}
    </>
  );
});

/** `@@ -a,b +c,d @@ trailing context` — the context after the second `@@` is meta. */
function HunkText({ text }: { text: string }) {
  const cut = text.indexOf("@@", 2);
  const head = cut === -1 ? text : text.slice(0, cut + 2);
  const tail = cut === -1 ? "" : text.slice(cut + 2);
  return (
    <>
      <span className="text-[var(--diff-hunk-fg)]">{head}</span>
      {tail && <span className="text-tertiary">{tail}</span>}
    </>
  );
}

function digitsOf(file: DiffFile): number {
  let max = 1;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      max = Math.max(max, line.oldNo ?? 0, line.newNo ?? 0);
    }
  }
  return String(max).length;
}

function GutterCell({ n, digits }: { n: number | null; digits: number }) {
  return (
    <span
      className="shrink-0 px-1.5 text-right text-quaternary tnum"
      style={{ ...CODE, width: `calc(${digits}ch + 12px)` }}
    >
      {n ?? ""}
    </span>
  );
}

/**
 * The gutter lives outside the horizontal scroller so line numbers stay put
 * while a long line scrolls. Both columns are built from the same 18px rows,
 * which is the only thing keeping them in register.
 */
function UnifiedFile({ file, lang }: { file: DiffFile; lang: string }) {
  const digits = digitsOf(file);
  const lines = useMemo(() => file.hunks.flatMap((hunk) => hunk.lines), [file]);

  return (
    <div className="flex">
      <div className="shrink-0 select-none border-r border-[var(--stroke-tertiary)] bg-canvas">
        {lines.map((line, i) => (
          <div
            key={i}
            className="flex items-center"
            style={{ height: ROW, background: line.kind === "hunk" ? "var(--fill-quaternary)" : bgOf(line.kind) }}
          >
            <GutterCell n={line.oldNo} digits={digits} />
            <GutterCell n={line.newNo} digits={digits} />
            <span
              className="shrink-0 text-center text-quaternary"
              style={{ ...CODE, width: 16, background: signBgOf(line.kind) }}
            >
              {line.kind === "hunk" ? "" : signOf(line.kind)}
            </span>
          </div>
        ))}
      </div>
      <div className="ink-scroll min-w-0 flex-1 overflow-x-auto">
        <div className="w-max min-w-full">
          {lines.map((line, i) => (
            <div
              key={i}
              className="px-2 text-primary"
              style={{
                ...CODE,
                height: ROW,
                background: line.kind === "hunk" ? "var(--fill-quaternary)" : bgOf(line.kind),
              }}
            >
              {line.kind === "hunk" ? (
                <HunkText text={line.text} />
              ) : (
                <CodeSpan text={line.text} lang={lang} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type PaneRow = { line: DiffLine | null; empty: string | undefined };

function SplitPane({
  rows,
  side,
  digits,
  lang,
}: {
  rows: PaneRow[];
  side: "left" | "right";
  digits: number;
  lang: string;
}) {
  return (
    <div className="flex min-w-0 flex-1">
      <div className="shrink-0 select-none border-r border-[var(--stroke-tertiary)] bg-canvas">
        {rows.map(({ line, empty }, i) => {
          const kind = line?.kind;
          return (
            <div
              key={i}
              className="flex items-center"
              style={{
                height: ROW,
                background: kind === "hunk" ? "var(--fill-quaternary)" : kind ? bgOf(kind) : empty,
              }}
            >
              <GutterCell
                n={line ? (side === "left" ? line.oldNo : line.newNo) : null}
                digits={digits}
              />
              <span
                className="shrink-0 text-center text-quaternary"
                style={{
                  ...CODE,
                  width: 16,
                  background: kind && kind !== "hunk" ? signBgOf(kind) : undefined,
                }}
              >
                {line && line.kind !== "hunk" ? signOf(line.kind) : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ink-scroll min-w-0 flex-1 overflow-x-auto">
        <div className="w-max min-w-full">
          {rows.map(({ line, empty }, i) => (
            <div
              key={i}
              className="px-2 text-primary"
              style={{
                ...CODE,
                height: ROW,
                background:
                  line === null
                    ? empty
                    : line.kind === "hunk"
                      ? "var(--fill-quaternary)"
                      : bgOf(line.kind),
              }}
            >
              {line === null ? null : line.kind === "hunk" ? (
                <HunkText text={line.text} />
              ) : (
                <CodeSpan text={line.text} lang={lang} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SplitFile({ file, lang }: { file: DiffFile; lang: string }) {
  const digits = digitsOf(file);
  const panes = useMemo(() => {
    const rows = file.hunks.flatMap((hunk) => splitRows(hunk.lines));
    // An unpaired cell is tinted at half the strength of the change it faces:
    // present enough to say "nothing stood here", quiet enough not to read as a
    // change of its own.
    const left: PaneRow[] = rows.map((row) => ({
      line: row.left,
      empty: row.left === null && row.right ? halfOf(row.right.kind) : undefined,
    }));
    const right: PaneRow[] = rows.map((row) => ({
      line: row.right,
      empty: row.right === null && row.left ? halfOf(row.left.kind) : undefined,
    }));
    return { left, right };
  }, [file]);

  return (
    <div className="flex">
      <SplitPane rows={panes.left} side="left" digits={digits} lang={lang} />
      <div className="w-px shrink-0 bg-[var(--stroke-tertiary)]" />
      <SplitPane rows={panes.right} side="right" digits={digits} lang={lang} />
    </div>
  );
}

function Tally({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tnum shrink-0 text-micro">
      <span className="text-[var(--status-success)]">+{added}</span>{" "}
      <span className="text-[var(--status-danger)]">−{removed}</span>
    </span>
  );
}

function FileHeader({
  path,
  added,
  removed,
  toolbar,
}: {
  path: string;
  added: number;
  removed: number;
  toolbar?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-[2] flex h-8 items-center gap-2 border-b border-[var(--stroke-tertiary)] bg-chrome px-2">
      <Icon name="fileCode" size={14} className="shrink-0 text-icon-faint" />
      <span className="ink-mono truncate text-secondary">{path}</span>
      <Tally added={added} removed={removed} />
      {toolbar && <div className="ml-auto flex shrink-0 items-center gap-1">{toolbar}</div>}
    </div>
  );
}

function useCopy(patch: string) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(patch);
    setDone(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1200);
  }, [patch]);

  return { done, copy };
}

function Files({ files, mode, path, toolbar }: {
  files: DiffFile[];
  mode: Mode;
  path?: string;
  toolbar?: ReactNode;
}) {
  const nameOf = (file: DiffFile, index: number) =>
    file.path ?? (index === 0 ? (path ?? null) : null);
  const firstNamed = files.findIndex((file, index) => nameOf(file, index) !== null);
  return (
    <>
      {files.map((file, index) => {
        const named = nameOf(file, index);
        const lang = langOfPath(named ?? "");
        const showToolbar = toolbar !== undefined && index === firstNamed;
        return (
          <div key={`${named ?? "patch"}-${index}`}>
            {named !== null && (
              <FileHeader
                path={named}
                added={file.added}
                removed={file.removed}
                {...(showToolbar ? { toolbar } : {})}
              />
            )}
            {mode === "split" ? (
              <SplitFile file={file} lang={lang} />
            ) : (
              <UnifiedFile file={file} lang={lang} />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Level 0 with an inset hairline — a diff is a body of content, not a card that
 * floats over one.
 */
export function DiffView({
  patch,
  path,
  mode = "unified",
  className,
  maxHeight,
}: {
  patch: string;
  path?: string;
  mode?: Mode;
  className?: string;
  maxHeight?: number;
}) {
  const [view, setView] = useState<Mode>(mode);
  const files = useMemo(() => parseDiff(patch), [patch]);
  const tally = useMemo(() => diffTally(files), [files]);
  const { done, copy } = useCopy(patch);

  const toolbar = (
    <>
      <Segmented
        size="sm"
        value={view}
        onChange={setView}
        options={[
          { value: "unified", label: "Unified" },
          { value: "split", label: "Split" },
        ]}
      />
      <IconButton
        size="sm"
        icon={done ? "check" : "copy"}
        label={done ? "Copied" : "Copy patch"}
        onClick={copy}
      />
    </>
  );

  const headless = files.length > 0 && files.every((file) => file.path === null) && !path;

  return (
    <div className={cx("hairline overflow-hidden rounded-card bg-canvas", className)}>
      {headless && (
        <div className="sticky top-0 z-[2] flex h-8 items-center gap-2 border-b border-[var(--stroke-tertiary)] bg-chrome px-2">
          <Icon name="diff" size={14} className="shrink-0 text-icon-faint" />
          <Tally added={tally.added} removed={tally.removed} />
          <div className="ml-auto flex shrink-0 items-center gap-1">{toolbar}</div>
        </div>
      )}
      <div
        className={cx("ink-scroll", maxHeight !== undefined && "overflow-y-auto")}
        style={maxHeight !== undefined ? { maxHeight } : undefined}
      >
        <Files
          files={files}
          mode={view}
          {...(path !== undefined ? { path } : {})}
          {...(headless ? {} : { toolbar })}
        />
      </div>
    </div>
  );
}

/** The embed: same renderer, no header, no controls, no height of its own. */
export function DiffBlock({ patch, className }: { patch: string; className?: string }) {
  const files = useMemo(() => parseDiff(patch), [patch]);
  return (
    <div className={cx("hairline overflow-hidden rounded-card bg-canvas", className)}>
      <Files files={files} mode="unified" />
    </div>
  );
}
