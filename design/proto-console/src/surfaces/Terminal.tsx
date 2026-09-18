import clsx from "clsx";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from "react";
import type { CursorStyle, Session, TerminalLine, Tone } from "@crew/fixtures";
import { Empty, IconButton, Input, ScrollArea } from "@/ui";
import { on } from "@/lib/commands";
import { source } from "@/lib/source";
import { useEscape } from "@/lib/hooks";
import { store, useApp } from "@/lib/store";

/* -------------------------------------------------------------------------- */
/* tones                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `--term-default` and `--term-dim` are not in the token file yet, so each falls
 * back to the ink step it stands for. Adding them later takes over here for free.
 */
const TONE: Record<Tone, CSSProperties> = {
  default: { color: "var(--term-default, var(--ink))" },
  dim: { color: "var(--term-dim, var(--ink-3))" },
  prompt: { color: "var(--term-prompt)" },
  path: { color: "var(--term-path)" },
  ok: { color: "var(--term-ok)" },
  warn: { color: "var(--term-warn)" },
  error: { color: "var(--term-error)" },
  accent: { color: "var(--term-accent)" },
  added: { color: "var(--term-ok)", background: "var(--add-bg)" },
  removed: { color: "var(--term-error)", background: "var(--del-bg)" },
};

const PATH_STYLE: CSSProperties = { color: "var(--term-path)" };

const MIN_FONT = 9;
const MAX_FONT = 22;
const RESET_FONT = 12.5;
const LINE_HEIGHT = 1.45;
const TAIL_CAP = 40;
const TAIL_EVERY = 1_400;
/** Rows above and below the viewport, so a fast flick never shows a gap. */
const OVERSCAN = 30;
/** The buffer's own padding, inside the scroller — every index calc subtracts it. */
const PAD = 8;

const clampFont = (size: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, size));

/* -------------------------------------------------------------------------- */
/* text → paths → matches                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A run that reads as a repo path: at least one slash, optionally `:line` or
 * `:line:col`. The lookbehind is what keeps it out of the middle of a URL.
 */
const PATH_RE = /(?<![\w/:.~-])(?:~\/|\/)?(?:[\w.@-]+\/)+[\w.@-]*(?::\d+(?::\d+)?)?/g;

type Piece = { text: string; path: boolean };
type Run = { text: string; hit: boolean };

function splitPaths(text: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  PATH_RE.lastIndex = 0;
  for (let match = PATH_RE.exec(text); match; match = PATH_RE.exec(text)) {
    if (match.index > at) pieces.push({ text: text.slice(at, match.index), path: false });
    pieces.push({ text: match[0], path: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), path: false });
  return pieces;
}

function splitMatches(text: string, needle: string): Run[] {
  if (!needle) return [{ text, hit: false }];
  const runs: Run[] = [];
  const hay = text.toLowerCase();
  let at = 0;
  let found = hay.indexOf(needle);
  while (found >= 0) {
    if (found > at) runs.push({ text: text.slice(at, found), hit: false });
    runs.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
    found = hay.indexOf(needle, at);
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false });
  return runs;
}

/** Counted through the same split that paints, so the tally never lies. */
function countRow(line: TerminalLine, needle: string): number {
  let total = 0;
  for (const segment of line) {
    for (const piece of splitPaths(segment.text)) {
      for (const run of splitMatches(piece.text, needle)) if (run.hit) total += 1;
    }
  }
  return total;
}

type Hits = {
  /** `starts[r]` is how many matches sit above row `r`. Non-decreasing. */
  starts: number[];
  total: number;
};

const NO_HITS: Hits = { starts: [], total: 0 };

/** The row holding match `index`: the last row whose running total is at most it. */
function rowOfMatch(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? 0) <= index) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const lineOf = (raw: string): number | undefined => {
  const match = /:(\d+)(?::\d+)?$/.exec(raw);
  return match?.[1] ? Number(match[1]) : undefined;
};

/**
 * The relative path a run points at, or null when a file tab would be a lie:
 * `~/.crew/crewd.log` sits outside the repo, and `crates/crew-core` is a
 * directory. A run that names a line is taken at its word.
 */
function repoRelative(raw: string, root: string, home: string): string | null {
  const bare = raw.replace(/:\d+(?::\d+)?$/, "");
  if (bare.endsWith("/")) return null;
  if (bare === raw && !/\.[A-Za-z0-9]+$/.test(bare)) return null;
  let out = bare;
  if (out.startsWith(`${root}/`)) out = out.slice(root.length + 1);
  else if (out.startsWith(`${home}/`)) out = out.slice(home.length + 1);
  if (out === "" || out.startsWith("/") || out.startsWith("~")) return null;
  return out;
}

/* -------------------------------------------------------------------------- */
/* the buffer, and the live tail after it                                      */
/* -------------------------------------------------------------------------- */

const isPrompt = (line: TerminalLine): boolean =>
  line[0]?.tone === "ok" && line[0].text === "➜";

/** The command a prompt line carries, if it carries one. */
function commandOf(line: TerminalLine | undefined): string | null {
  if (!line || !isPrompt(line)) return null;
  const tail = line.at(-1);
  if (!tail || tail.tone !== undefined) return null;
  return tail.text.trim() === "" ? null : tail.text;
}

type Level = "INFO" | "WARN" | "DEBUG" | "ERROR";

const LEVEL_TONE: Record<Level, Tone> = {
  INFO: "default",
  DEBUG: "dim",
  WARN: "warn",
  ERROR: "error",
};

type TailEntry = { level: Level; target: string; text: string };

/** One turn of a daemon log: the counters move, so no two lines repeat exactly. */
const TAIL: Array<(n: number) => TailEntry> = [
  (n) => ({
    level: "DEBUG",
    target: "crew_core::harness",
    text: `claude · content_block_delta seq=${1841 + n * 7} len=${180 + ((n * 37) % 620)}`,
  }),
  (n) => ({
    level: "INFO",
    target: "crewd::rpc",
    text: `client 3 → session.poll s-harness since seq ${1800 + n * 7}`,
  }),
  () => ({
    level: "DEBUG",
    target: "crew_core::stream",
    text: `normalise tool_use edit → ToolDetail::Edit (+6 −2)`,
  }),
  (n) => ({
    level: "INFO",
    target: "crewd::store",
    text: `appended ${2 + (n % 5)} events to ~/.crew/state/s-harness.jsonl`,
  }),
  (n) => ({
    level: "DEBUG",
    target: "crewd::rpc",
    text: `client 1 ← 3 events (${612 + ((n * 53) % 900)} bytes)`,
  }),
  () => ({
    level: "WARN",
    target: "crew_core::providers",
    text: `codex · unknown tool kind "exec_command", falling back to run`,
  }),
  (n) => ({
    level: "INFO",
    target: "crew_core::watch",
    text: `fs event: src/lib/tabs.ts modified (${3 + (n % 4)} watchers)`,
  }),
  (n) => ({
    level: "DEBUG",
    target: "crew_core::harness",
    text: `heartbeat ok · 3 sessions · rss ${64 + (n % 9)}.${n % 10} MB`,
  }),
  () => ({
    level: "WARN",
    target: "crew_core::harness",
    text: 'unused variable `seq` at crates/crew-core/src/harness.rs:884:13',
  }),
  (n) => ({
    level: "INFO",
    target: "crew_core::providers",
    text: `claude · stream closed (end_turn) in ${18 + (n % 7)}.${(n * 3) % 10}s`,
  }),
  () => ({
    level: "ERROR",
    target: "crewd::rpc",
    text: `client 4 dropped: connection reset by peer`,
  }),
  (n) => ({
    level: "INFO",
    target: "crewd::session",
    text: `s-harness · turn ${12 + (n % 3)} · 18.4k in · 620 out · $0.09`,
  }),
];

const pad = (value: number, width: number) => String(value).padStart(width, "0");

function stampOf(at: Date): string {
  return `${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)}.${pad(
    at.getMilliseconds(),
    3,
  )}`;
}

function tailLine(n: number): TerminalLine {
  const make = TAIL[n % TAIL.length];
  const entry: TailEntry = make ? make(n) : { level: "INFO", target: "crewd", text: "…" };
  return [
    { text: `${stampOf(new Date())}  `, tone: "dim" },
    { text: entry.level.padEnd(5), tone: LEVEL_TONE[entry.level] },
    { text: "  " },
    { text: entry.target.padEnd(21), tone: "accent" },
    { text: entry.text },
  ];
}

/* -------------------------------------------------------------------------- */
/* cursor                                                                      */
/* -------------------------------------------------------------------------- */

const BAR: CSSProperties = {
  display: "inline-block",
  width: "2px",
  height: "1.05em",
  verticalAlign: "-0.18em",
  background: "currentColor",
  animation: "blink 1.06s steps(1, end) infinite",
};

const UNDERLINE: CSSProperties = { ...BAR, width: "0.6em", height: "2px", verticalAlign: "0" };

function Cursor({ shape }: { shape: CursorStyle }) {
  if (shape === "block") return <span aria-hidden className="caret" />;
  return <span aria-hidden style={shape === "bar" ? BAR : UNDERLINE} />;
}

/* -------------------------------------------------------------------------- */
/* surface                                                                     */
/* -------------------------------------------------------------------------- */

export function Terminal({
  session,
  active,
}: {
  session: Session | null;
  active: boolean;
}): JSX.Element {
  const state = useApp();
  const { fontFamily, fontSize, cursorStyle } = state.terminal;

  // null while the read is in flight — an empty array is a real, different answer.
  const [buffer, setBuffer] = useState<TerminalLine[] | null>(null);
  const [tail, setTail] = useState<TerminalLine[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [focusSeq, setFocusSeq] = useState(0);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);

  const seq = useRef(0);
  const findRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Pinned to the bottom until the reader scrolls away from it. */
  const stuck = useRef(true);
  /** The first row on screen, so a zoom can put the reader back on it. */
  const anchor = useRef(0);

  const sessionId = session?.id ?? "t-build";
  const rowH = Math.max(1, Math.round(fontSize * LINE_HEIGHT));

  const workspace =
    state.workspaces.find((w) => w.id === (session?.workspaceId ?? state.workspaceId)) ??
    state.workspaces[0];
  const root = workspace?.path ?? "";
  const home = root.replace(/^\/Users\/[^/]+/, "~");

  useEffect(() => {
    let alive = true;
    setBuffer(null);
    void source.terminal(sessionId).then((lines) => {
      if (alive) setBuffer(lines);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const view = useMemo(() => {
    const lines = buffer ?? [];
    const last = lines.at(-1);
    const running = commandOf(last) !== null;
    // A bare prompt is where the cursor sits; a running command gets its own line.
    const bare = !running && last !== undefined && isPrompt(last);
    return {
      running,
      body: bare ? lines.slice(0, -1) : lines,
      prompt: bare ? last : null,
    };
  }, [buffer]);

  /** Every row the surface can show, cursor row included, one per screen line. */
  const rows = useMemo(() => {
    const body = view.running ? [...view.body, ...tail] : view.body;
    return [...body, view.prompt ?? [{ text: "" }]];
  }, [view, tail]);

  const needle = query.trim().toLowerCase();
  // Counted over the whole buffer, not the window — and the running totals are
  // what lets the find bar jump to a match that is not mounted.
  const hits = useMemo<Hits>(() => {
    if (!needle) return NO_HITS;
    const starts = new Array<number>(rows.length);
    let total = 0;
    for (let i = 0; i < rows.length; i += 1) {
      starts[i] = total;
      total += countRow(rows[i] ?? [], needle);
    }
    return { starts, total };
  }, [rows, needle]);
  const total = hits.total;

  /* --- the window ------------------------------------------------------- */

  const first = Math.max(0, Math.floor((scrollTop - PAD) / rowH) - OVERSCAN);
  const last = Math.min(rows.length, first + Math.ceil(viewH / rowH) + OVERSCAN * 2);
  const slice = rows.slice(first, last);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setScrollTop(node.scrollTop);
    anchor.current = Math.max(0, Math.floor((node.scrollTop - PAD) / rowH));
    // A row of slack: a reader one line off the bottom still counts as there.
    stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight <= rowH;
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setViewH(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !stuck.current) return;
    node.scrollTop = node.scrollHeight;
    setScrollTop(node.scrollTop);
  }, [rows.length, rowH, buffer]);

  // Zoom changes the row height under the reader: keep their top row their top row.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || stuck.current) return;
    node.scrollTop = PAD + anchor.current * rowH;
    setScrollTop(node.scrollTop);
  }, [rowH]);

  /* --- the tail --------------------------------------------------------- */

  // The tail is the only thing here that costs anything, so a hidden tab stops it.
  useEffect(() => {
    if (!active || !view.running) return;
    const timer = window.setInterval(() => {
      const n = seq.current;
      seq.current += 1;
      setTail((held) => [...held, tailLine(n)].slice(-TAIL_CAP));
    }, TAIL_EVERY);
    return () => window.clearInterval(timer);
  }, [active, view.running]);

  /* --- chrome ----------------------------------------------------------- */

  useEffect(() => {
    if (!active) return;
    return on("terminal:zoom", (detail) => {
      const delta = typeof detail === "number" ? detail : 0;
      // Read the store, not the closure: the chord can repeat faster than a render.
      const next = delta === 0 ? RESET_FONT : store.state.terminal.fontSize + delta;
      store.setTerminal({ fontSize: clampFont(next) });
    });
  }, [active]);

  useEffect(() => {
    if (!active) return;
    return on("terminal:find", () => {
      setFindOpen(true);
      setFocusSeq((n) => n + 1);
    });
  }, [active]);

  useEscape(() => setFindOpen(false), findOpen && active);

  useEffect(() => {
    if (!findOpen) return;
    const input = findRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [findOpen, focusSeq]);

  useEffect(() => {
    setCurrent(0);
  }, [needle]);

  // Scrolled to by index: the current match usually is not mounted to scroll to.
  useEffect(() => {
    const node = scrollRef.current;
    if (!findOpen || total === 0 || !node) return;
    const row = rowOfMatch(hits.starts, current);
    const centred = PAD + row * rowH - Math.max(0, (node.clientHeight - rowH) / 2);
    node.scrollTop = Math.max(0, centred);
    setScrollTop(node.scrollTop);
  }, [findOpen, current, total, hits.starts, rowH]);

  const step = (delta: number) => {
    if (total === 0) return;
    setCurrent((held) => (held + delta + total) % total);
  };

  const zoom = (next: number) => store.setTerminal({ fontSize: clampFont(next) });

  /* --- painting --------------------------------------------------------- */

  const paintRuns = (text: string, key: string, counter: { seen: number }): ReactNode => {
    const runs = splitMatches(text, needle);
    if (runs.length === 1 && runs[0]?.hit === false) return text;
    return runs.map((run, index) => {
      if (!run.hit) return <span key={`${key}-${index}`}>{run.text}</span>;
      const isCurrent = counter.seen === current;
      counter.seen += 1;
      return (
        <span
          key={`${key}-${index}`}
          className={clsx(
            "rounded-[var(--r)]",
            isCurrent ? "bg-accent text-accent-on" : "bg-mark",
          )}
        >
          {run.text}
        </span>
      );
    });
  };

  const paintRow = (line: TerminalLine, at: number, trailing?: ReactNode): ReactNode => {
    const key = `r${at}`;
    // Matches are numbered per row, seeded from the running total, so a painted
    // row knows its own indices without the rows above it being mounted.
    const counter = { seen: hits.starts[at] ?? 0 };
    return (
      <div key={key} className="whitespace-pre" style={{ height: rowH, lineHeight: `${rowH}px` }}>
        {line.map((segment, index) => (
          <span key={index} style={TONE[segment.tone ?? "default"]}>
            {splitPaths(segment.text).map((piece, pieceIndex) => {
              const pieceKey = `${key}-${index}-${pieceIndex}`;
              const relative = piece.path ? repoRelative(piece.text, root, home) : null;
              if (!relative) {
                return <span key={pieceKey}>{paintRuns(piece.text, pieceKey, counter)}</span>;
              }
              const line1 = lineOf(piece.text);
              return (
                <button
                  key={pieceKey}
                  type="button"
                  title={`Open ${relative}`}
                  style={PATH_STYLE}
                  onClick={() => store.openFile(relative, line1)}
                  className="rounded-[var(--r)] underline-offset-2 hover:underline"
                >
                  {paintRuns(piece.text, pieceKey, counter)}
                </button>
              );
            })}
          </span>
        ))}
        {trailing}
      </div>
    );
  };

  const count =
    needle === "" ? "" : total === 0 ? "0/0" : `${Math.min(current + 1, total)}/${total}`;
  const held = rows.length - 1;
  const loading = buffer === null;
  const empty = !loading && held === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex h-[24px] shrink-0 items-center gap-3 border-b border-rule bg-raised px-2 font-mono text-xs text-ink-3 select-none">
        <span className="shrink-0 text-ink-2">{session?.name ?? "terminal"}</span>
        <span className="min-w-0 truncate text-ink-4">{home}</span>
        <span className="shrink-0 text-ink-4">
          {loading ? "reading…" : `${held.toLocaleString()} lines`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Strip
            label="find"
            title="Find in terminal"
            onClick={() => {
              setFindOpen((open) => !open);
              setFocusSeq((n) => n + 1);
            }}
          />
          <span className="flex items-center gap-1">
            <Strip
              label="−"
              title="Decrease font size"
              disabled={fontSize <= MIN_FONT}
              onClick={() => zoom(fontSize - 1)}
            />
            <span className="w-[42px] text-center text-ink-4">{fontSize}px</span>
            <Strip
              label="+"
              title="Increase font size"
              disabled={fontSize >= MAX_FONT}
              onClick={() => zoom(fontSize + 1)}
            />
          </span>
          <Strip label="settings" onClick={() => store.openSettings("terminal")} />
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1">
          {loading ? (
            <p className="px-3 py-2 font-mono text-sm text-ink-4">reading scrollback…</p>
          ) : empty ? (
            <Empty
              title="Nothing in this terminal yet"
              hint="The session is attached but has printed no scrollback."
            />
          ) : (
            <div
              className="w-max min-w-full px-3 text-ink select-text"
              style={{
                fontFamily: `"${fontFamily}", var(--font-mono)`,
                fontSize,
                paddingTop: PAD,
                paddingBottom: PAD,
                fontVariantLigatures: "none",
              }}
            >
              <div style={{ height: first * rowH }} />
              {slice.map((line, index) =>
                first + index === rows.length - 1
                  ? paintRow(line, first + index, <Cursor shape={cursorStyle} />)
                  : paintRow(line, first + index),
              )}
              <div style={{ height: (rows.length - last) * rowH }} />
            </div>
          )}
        </ScrollArea>

        {findOpen ? (
          <div
            ref={findRef}
            className="float absolute top-2 right-2 z-10 flex items-center gap-1 p-1 select-none"
          >
            <div className="w-[180px]">
              <Input
                mono
                value={query}
                placeholder="find"
                aria-label="Find in terminal"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }}
              />
            </div>
            <span className="w-[52px] text-center font-mono text-xs text-ink-3">{count}</span>
            <IconButton label="Previous match" disabled={total === 0} onClick={() => step(-1)}>
              <span className="font-mono text-xs">↑</span>
            </IconButton>
            <IconButton label="Next match" disabled={total === 0} onClick={() => step(1)}>
              <span className="font-mono text-xs">↓</span>
            </IconButton>
            <IconButton label="Close find" onClick={() => setFindOpen(false)}>
              <span className="font-mono text-xs">✕</span>
            </IconButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A header affordance: a word, not a button shape. */
function Strip({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-[var(--r)] px-1 text-ink-3 transition-colors duration-[var(--fast)] hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      {label}
    </button>
  );
}
