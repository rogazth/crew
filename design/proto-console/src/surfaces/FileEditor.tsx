import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FILE_CONTENTS, contentsOf, diffs } from "@crew/fixtures";
import { Badge, CommandKbd, Segmented } from "@/ui";
import { highlightLines, langFromPath, type Lang } from "@/lib/highlight";
import { store, useApp } from "@/lib/store";
import { DiffView } from "./DiffView";

type Mode = "file" | "diff" | "split";

const MODES = [
  { id: "file" as const, label: "File" },
  { id: "diff" as const, label: "Diff" },
  { id: "split" as const, label: "Split" },
];

/** Past this, highlighting is dropped and the header says so. */
const PLAIN_AT = 20_000;
/** Past this, only the lines in view are painted. */
const VIRTUAL_AT = 400;
const OVERSCAN = 40;
const PAD_Y = 4;
const PAD_L = 12;
const PAD_R = 24;

export function FileEditor({ relative, active }: { relative: string; active: boolean }) {
  const state = useApp();
  const dirty = state.dirty[relative];
  const lineH = state.density === "compact" ? 17 : 18;

  const base = useMemo(() => bodyOf(relative), [relative]);
  const [saved, setSaved] = useState(base);
  const held = useRef(dirty);

  // `saveFile` only drops the dirty key — the fixture bodies are frozen — so the
  // editor keeps the text it was holding when the key went away.
  useEffect(() => {
    if (held.current !== undefined && dirty === undefined) setSaved(held.current);
    held.current = dirty;
  }, [dirty]);
  useEffect(() => setSaved(base), [base]);

  const text = dirty ?? saved;
  const lang = langFromPath(relative);
  const fixture = diffs.find((entry) => entry.path === relative);
  const [mode, setMode] = useState<Mode>("file");

  const at = relative.lastIndexOf("/");
  const dir = at < 0 ? "" : relative.slice(0, at + 1);
  const name = relative.slice(at + 1);

  const plain = text.length > PLAIN_AT || lang === "text";
  const lines = useMemo(() => text.split("\n"), [text]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);
  const shown = fixture ? mode : "file";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[var(--h-tabs)] shrink-0 items-center gap-2 border-b border-rule px-2 font-mono text-sm">
        <span className="min-w-0 truncate">
          <span className="text-ink-4">{dir}</span>
          <span className="text-ink">{name}</span>
        </span>
        {dirty !== undefined ? (
          <span
            title="Unsaved changes"
            className="block size-[6px] shrink-0 rounded-full bg-current opacity-70"
          />
        ) : null}
        {plain ? <Badge>plain text</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {fixture ? (
            <Segmented value={shown} options={MODES} onChange={setMode} label="File or diff" />
          ) : null}
          <CommandKbd
            id="save-file"
            className={dirty !== undefined ? "border-accent text-accent-ink!" : ""}
          />
        </span>
      </div>

      {shown === "file" ? (
        <Body
          relative={relative}
          text={text}
          lines={lines}
          lang={lang}
          plain={plain}
          lineH={lineH}
          active={active}
        />
      ) : (
        <div className="scroll min-h-0 flex-1 p-3">
          <DiffView
            patch={fixture!.patch}
            path={relative}
            added={fixture!.added}
            removed={fixture!.removed}
            mode={shown === "split" ? "split" : "unified"}
          />
        </div>
      )}

      <div className="flex h-[var(--h-status)] shrink-0 items-center gap-2 border-t border-rule px-2 font-mono text-xs text-ink-4">
        {shown === "file" ? (
          <span>
            {lines.length} lines · {plain ? "plain text" : lang} · {sizeOf(bytes)}
          </span>
        ) : (
          <span>
            <span className="text-green-ink">+{fixture!.added}</span>{" "}
            <span className="text-red-ink">−{fixture!.removed}</span> · {shown} · {relative}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A transparent textarea sits exactly on top of the painted lines: one scroller,
 * one set of metrics, so the caret can never drift off its own text.
 */
function Body({
  relative,
  text,
  lines,
  lang,
  plain,
  lineH,
  active,
}: {
  relative: string;
  text: string;
  lines: string[];
  lang: Lang;
  plain: boolean;
  lineH: number;
  active: boolean;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [window_, setWindow] = useState({ start: 0, end: VIRTUAL_AT });

  const total = lines.length;
  const virtual = total > VIRTUAL_AT;
  const painted = useMemo(() => (plain ? null : highlightLines(text, lang)), [plain, text, lang]);
  const widest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.length), 0), [lines]);

  const measure = useCallback(() => {
    const node = scroller.current;
    if (!node) return;
    const first = Math.max(0, Math.floor((node.scrollTop - PAD_Y) / lineH));
    const fits = Math.ceil(node.clientHeight / lineH);
    setWindow((was) => {
      const start = Math.max(0, first - OVERSCAN);
      const end = first + fits + OVERSCAN;
      return was.start === start && was.end === end ? was : { start, end };
    });
  }, [lineH]);

  useLayoutEffect(measure, [measure, total]);

  useEffect(() => {
    if (active) area.current?.focus({ preventScroll: true });
  }, [active]);

  const start = virtual ? Math.min(window_.start, Math.max(0, total - 1)) : 0;
  const end = virtual ? Math.min(total, window_.end) : total;
  const slice = lines.slice(start, end);

  const metrics: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--t-sm)",
    lineHeight: `${lineH}px`,
    tabSize: 2,
    whiteSpace: "pre",
  };
  const height = total * lineH + PAD_Y * 2;
  const digits = String(total).length;

  return (
    <div
      ref={scroller}
      onScroll={measure}
      className="scroll relative min-h-0 flex-1"
    >
      <div className="flex min-h-full w-max min-w-full">
        <div
          className="sticky left-0 z-10 shrink-0 border-r border-rule bg-bg pr-2 pl-3 text-right text-ink-4 select-none"
          style={{ ...metrics, paddingTop: PAD_Y, width: `calc(${digits}ch + 28px)` }}
        >
          <span className="block" style={{ height: start * lineH }} />
          {slice.map((_, index) => (
            <span key={start + index} className="block" style={{ height: lineH }}>
              {start + index + 1}
            </span>
          ))}
          <span className="block" style={{ height: (total - end) * lineH }} />
        </div>

        <div
          className="relative flex-1"
          style={{ height, minWidth: `calc(${widest}ch + ${PAD_L + PAD_R}px)` }}
        >
          <pre
            aria-hidden
            className="absolute inset-0 overflow-hidden"
            style={{ ...metrics, padding: `${PAD_Y}px ${PAD_R}px ${PAD_Y}px ${PAD_L}px` }}
          >
            <span className="block" style={{ height: start * lineH }} />
            {slice.map((line, index) => {
              const tokens = painted?.[start + index];
              return (
                <span key={start + index} className="block" style={{ height: lineH }}>
                  {tokens
                    ? tokens.map((token, n) => (
                        <span key={n} className={`tok-${token.c}`}>
                          {token.t}
                        </span>
                      ))
                    : line}
                </span>
              );
            })}
            <span className="block" style={{ height: (total - end) * lineH }} />
          </pre>

          <textarea
            ref={area}
            value={text}
            wrap="off"
            spellCheck={false}
            aria-label={relative}
            onChange={(event) => store.setDirty(relative, event.target.value)}
            onScroll={(event) => {
              // The caret can drag the textarea past its own edge; hand that to
              // the one real scroller instead so the paint stays underneath.
              const node = event.currentTarget;
              const outer = scroller.current;
              if (!outer || (!node.scrollTop && !node.scrollLeft)) return;
              outer.scrollTop += node.scrollTop;
              outer.scrollLeft += node.scrollLeft;
              node.scrollTop = 0;
              node.scrollLeft = 0;
            }}
            className="absolute inset-0 resize-none overflow-hidden bg-transparent text-transparent outline-none"
            style={{
              ...metrics,
              padding: `${PAD_Y}px ${PAD_R}px ${PAD_Y}px ${PAD_L}px`,
              caretColor: "var(--ink)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * Every fixture body is under sixty lines, and an editor that never scrolls
 * proves nothing about one that has to. A project path with no fixture gets a
 * synthetic body instead of the "pick one of" stub — long enough that the
 * virtual window, the sticky gutter and the plain-text fallback all do real work.
 */
function bodyOf(relative: string): string {
  const fixture = FILE_CONTENTS[relative];
  if (fixture !== undefined) return fixture;
  const lang = langFromPath(relative);
  if (lang === "rust") return synthRust(relative);
  if (lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx") return synthTs(relative);
  return contentsOf(relative);
}

const NOUNS = ["tab", "session", "block", "route", "chord", "hunk", "token", "patch"];
const TYPES = ["TabState", "Session", "Block", "Route", "Chord", "Hunk", "Token", "Patch"];

/** A stable block count per path: some files land under the plain-text cut, some over. */
function blocksFor(relative: string): number {
  let hash = 7;
  for (const ch of relative) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return 56 + (hash % 132);
}

function preamble(relative: string, comment: string): string[] {
  return [
    `${comment} ${relative}`,
    `${comment}`,
    `${comment} Synthesised for the prototype. The shape is real, the work is not:`,
    `${comment} this file exists so the editor has something long to scroll.`,
    "",
  ];
}

function synthTs(relative: string): string {
  const out = preamble(relative, "//");
  out.push(
    `import { cache } from "./cache";`,
    `import type { Block, Chord, Hunk, Patch, Route, Session, TabState, Token } from "./types";`,
    "",
  );
  const count = blocksFor(relative);
  for (let i = 0; i < count; i += 1) {
    const noun = NOUNS[i % NOUNS.length]!;
    const type = TYPES[i % TYPES.length]!;
    out.push(
      `/** ${noun} #${i}, normalised. */`,
      `export function ${noun}${i}(x: ${type}): ${type} {`,
      `  const held = cache.get(x.id);`,
      `  if (held) return held as ${type};`,
      `  const next = { ...x, at: Date.now() };`,
      `  cache.set(x.id, next);`,
      `  return next;`,
      `}`,
      "",
    );
  }
  return out.join("\n");
}

function synthRust(relative: string): string {
  const out = preamble(relative, "//");
  out.push(
    `use std::collections::HashMap;`,
    `use serde::{Deserialize, Serialize};`,
    "",
    `static CACHE: HashMap<String, u64> = HashMap::new();`,
    "",
  );
  const count = blocksFor(relative);
  for (let i = 0; i < count; i += 1) {
    const noun = NOUNS[i % NOUNS.length]!;
    const type = TYPES[i % TYPES.length]!;
    out.push(
      `/// ${noun} #${i}.`,
      `#[derive(Debug, Clone, Serialize, Deserialize)]`,
      `pub struct ${type}${i} {`,
      `    pub id: String,`,
      `    pub at: u64,`,
      `}`,
      "",
      `impl ${type}${i} {`,
      `    pub fn normalise(&self, at: u64) -> Self {`,
      `        let held = CACHE.get(&self.id).copied().unwrap_or(0);`,
      `        Self { id: self.id.clone(), at: held.max(at) }`,
      `    }`,
      `}`,
      "",
    );
  }
  return out.join("\n");
}
