import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  COMMANDS,
  matchesChord,
  type CursorStyle,
  type TerminalLine,
  type Tone,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useBus } from "@/lib/bus";
import { relativeOf } from "@/lib/files";
import { SOURCE } from "@/lib/source";
import { useApp } from "@/lib/store";
import { IconButton, Input, Menu, MenuItem, MenuSeparator } from "@/ui";

const TONE: Record<Tone, string> = {
  default: "var(--term-default)",
  dim: "var(--term-dim)",
  prompt: "var(--term-prompt)",
  path: "var(--term-path)",
  ok: "var(--term-ok)",
  warn: "var(--term-warn)",
  error: "var(--term-error)",
  accent: "var(--term-accent)",
  added: "var(--term-added)",
  removed: "var(--term-removed)",
};

const MIN_FONT = 10;
const MAX_FONT = 20;
const RESET_FONT = 12;
const LINE_HEIGHT = 1.45;

const clampFont = (size: number) => Math.min(MAX_FONT, Math.max(MIN_FONT, size));

const EMPTY_BUFFER: TerminalLine[] = [];

/* -------------------------------------------------------------------------- */
/* text → clickable paths → search hits                                        */
/* -------------------------------------------------------------------------- */

/**
 * A run that reads as a repo path: at least one slash, a real last component,
 * optionally `:line` or `:line:col`. The lookbehind is what keeps it out of the
 * middle of a URL or a version number.
 */
const PATH_RE = /(?<![\w/:.~-])(?:~\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+(?::\d+(?::\d+)?)?/g;

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

/** Counted through the same pipeline that paints, so the tally never lies. */
function countLine(line: TerminalLine, needle: string): number {
  if (!needle) return 0;
  let total = 0;
  for (const segment of line) {
    for (const piece of splitPaths(segment.text)) {
      for (const run of splitMatches(piece.text, needle)) if (run.hit) total += 1;
    }
  }
  return total;
}

/** The first match index on each line, so a windowed row still numbers its own. */
function prefixCounts(lines: TerminalLine[], needle: string): number[] {
  const out = new Array<number>(lines.length + 1);
  out[0] = 0;
  for (let i = 0; i < lines.length; i += 1) {
    out[i + 1] = out[i]! + countLine(lines[i]!, needle);
  }
  return out;
}

/** Which line holds the nth match. */
function lineOfMatch(prefix: number[], n: number): number {
  let lo = 0;
  let hi = prefix.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1]! <= n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const OVERSCAN = 40;

/* -------------------------------------------------------------------------- */
/* cursor                                                                      */
/* -------------------------------------------------------------------------- */

/** The app's one blink. Three shapes, one animation — nothing new spins. */
const BLINK: CSSProperties = { animation: "ink-blink 1100ms steps(2, jump-none) infinite" };

function Cursor({ style }: { style: CursorStyle }) {
  // The block covers a whole cell, so it takes the quieter ink; the bar and the
  // underline are two pixels of it and need the full terminal weight to read.
  const shape =
    style === "bar"
      ? "w-[2px] h-[1.02em] align-[-0.2em] bg-[var(--term-default)]"
      : style === "underline"
        ? "w-[0.62em] h-[2px] align-[-0.04em] bg-[var(--term-default)]"
        : "w-[0.62em] h-[1.02em] align-[-0.2em] rounded-[1px] bg-[var(--text-quaternary)]";
  return <span aria-hidden className={cx("ml-px inline-block", shape)} style={BLINK} />;
}

/* -------------------------------------------------------------------------- */
/* buffer plumbing                                                             */
/* -------------------------------------------------------------------------- */

const prompt = (cwd: string): TerminalLine => [
  { text: "➜", tone: "ok" },
  { text: " " },
  { text: cwd, tone: "accent" },
  { text: " " },
  { text: "git:(", tone: "dim" },
  { text: "master", tone: "error" },
  { text: ")", tone: "dim" },
  { text: " " },
];

/** The prompt the surface is sitting at, carrying the running command if there is one. */
const liveLine = (cwd: string, running: string | null): TerminalLine =>
  running ? [...prompt(cwd), { text: running }] : prompt(cwd);

/** The command a prompt line carries, if it carries one. */
function commandOf(line: TerminalLine | undefined): string | null {
  const tail = line?.at(-1);
  if (!line || !tail) return null;
  if (line[0]?.tone !== "ok" || line[0].text !== "➜") return null;
  return tail.tone === undefined && tail.text.trim() !== "" ? tail.text : null;
}

export function Terminal({ sessionId }: { sessionId: string }) {
  const { sessions, workspace, terminal, actions } = useApp();
  const session = sessions.find((s) => s.id === sessionId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  // Clear and Restart have no PTY behind them: they only reset this surface.
  const [cleared, setCleared] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const cwd = workspace.path.split("/").pop() ?? workspace.name;
  const home = workspace.path.replace(/^\/Users\/[^/]+/, "~");

  const [loaded, setLoaded] = useState<TerminalLine[]>([]);
  useEffect(() => {
    let alive = true;
    void SOURCE.terminal(sessionId).then((lines) => alive && setLoaded(lines));
    return () => {
      alive = false;
    };
  }, [sessionId, epoch]);

  const buffer = cleared ? EMPTY_BUFFER : loaded;

  // A `working` session has not come back to the prompt: the last command in its
  // buffer is the one still running, so it is re-rendered live with the cursor
  // after it instead of sitting in the scrollback.
  const running = session?.status === "working" ? commandOf(buffer.at(-1)) : null;
  const body = running ? buffer.slice(0, -1) : buffer;

  const live = liveLine(cwd, running);
  const needle = query.trim().toLowerCase();
  const prefix = useMemo(() => prefixCounts(body, needle), [body, needle]);
  const liveMatches = useMemo(() => countLine(live, needle), [live, needle]);
  const total = prefix[prefix.length - 1]! + liveMatches;

  // A 50k-line scrollback is a real buffer, so the surface windows it. Rows are
  // one line tall and do not wrap, which is what a terminal does anyway.
  const rowH = Math.round(terminal.fontSize * LINE_HEIGHT);
  const [win, setWin] = useState({ start: 0, end: 200 });
  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const start = Math.max(0, Math.floor((node.scrollTop - 12) / rowH) - OVERSCAN);
    const end = Math.ceil((node.scrollTop - 12 + node.clientHeight) / rowH) + OVERSCAN;
    setWin((held) => (held.start === start && held.end === end ? held : { start, end }));
  }, [rowH]);

  useEffect(() => {
    measure();
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure, body.length]);

  useEffect(() => {
    setCurrent(0);
  }, [needle]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [sessionId, epoch, cleared]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  // The match may be outside the window, so the scroll is computed from the
  // line index rather than found in the DOM.
  useEffect(() => {
    if (!findOpen || total === 0) return;
    const node = scrollRef.current;
    if (!node) return;
    const line = current < prefix[prefix.length - 1]! ? lineOfMatch(prefix, current) : body.length;
    const target = 12 + line * rowH - node.clientHeight / 2;
    node.scrollTop = Math.max(0, target);
  }, [findOpen, current, needle, total, prefix, body.length, rowH]);

  const step = (delta: number) => {
    if (total === 0) return;
    setCurrent((prev) => (prev + delta + total) % total);
  };

  const zoom = (next: number) => actions.setTerminal({ fontSize: clampFont(next) });

  // The terminal owns Mod+F, so the listener lives on the window — but the surface
  // is only mounted while its tab is the active one, which is the guard. The zoom
  // chords are not here: they only change store state, so the shell binds them and
  // the palette's "Increase Terminal Font" works with no terminal open.
  const openFind = useCallback(() => {
    setFindOpen(true);
    findInputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matchesChord(event, COMMANDS["find-in-terminal"].keys)) return;
      event.preventDefault();
      openFind();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFind]);

  useBus("terminal:find", openFind);

  const barePath = (raw: string) => raw.replace(/:\d+(?::\d+)?$/, "");
  // The workspace root is a path too, and opening it as a file is nonsense.
  const clickable = (raw: string) => {
    const bare = barePath(raw);
    return bare !== workspace.path && bare !== `${workspace.path}/`;
  };
  const openPath = (raw: string) => actions.openFile(relativeOf(barePath(raw)));

  // Matches are numbered by line, so a windowed row still knows which of its
  // highlights is the one the find bar is on.
  const counter = { seen: 0 };

  const paintRuns = (text: string, key: string): ReactNode => {
    const runs = splitMatches(text, needle);
    if (runs.length === 1 && !runs[0]!.hit) return text;
    return runs.map((run, index) => {
      if (!run.hit) return <span key={`${key}-${index}`}>{run.text}</span>;
      const at = counter.seen;
      counter.seen += 1;
      const isCurrent = at === current;
      return (
        <span
          key={`${key}-${index}`}
          {...(isCurrent ? { "data-current-match": "" } : {})}
          className={cx(
            "rounded-xs",
            isCurrent
              ? "bg-[var(--status-attention)] text-[var(--surface-canvas)]"
              : "bg-[var(--mark-fill)]",
          )}
        >
          {run.text}
        </span>
      );
    });
  };

  const paintLine = (
    line: TerminalLine,
    key: string,
    base: number,
    trailing?: ReactNode,
  ): ReactNode => {
    counter.seen = base;
    const blank = line.every((segment) => segment.text === "");
    return (
      <div key={key} className="whitespace-pre" style={{ height: rowH }}>
        {blank && !trailing ? (
          " "
        ) : (
          <>
            {line.map((segment, index) => (
              <span key={index} style={{ color: TONE[segment.tone ?? "default"] }}>
                {splitPaths(segment.text).map((piece, pieceIndex) => {
                  const pieceKey = `${key}-${index}-${pieceIndex}`;
                  if (!piece.path || !clickable(piece.text)) {
                    return <span key={pieceKey}>{paintRuns(piece.text, pieceKey)}</span>;
                  }
                  return (
                    <button
                      key={pieceKey}
                      type="button"
                      onClick={() => openPath(piece.text)}
                      title={`Open ${piece.text}`}
                      className="cursor-pointer rounded-xs text-[var(--term-path)] underline-offset-2 hover:underline"
                    >
                      {paintRuns(piece.text, pieceKey)}
                    </button>
                  );
                })}
              </span>
            ))}
            {trailing}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] bg-chrome px-2">
        <span className="min-w-0 shrink truncate text-small text-primary">
          {session?.name ?? "terminal"}
        </span>
        <span className="min-w-0 shrink truncate text-micro text-quaternary">
          zsh · {home}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            size="sm"
            icon="zoomOut"
            label="Decrease font size"
            disabled={terminal.fontSize <= MIN_FONT}
            onClick={() => zoom(terminal.fontSize - 1)}
          />
          <button
            type="button"
            onClick={() => zoom(RESET_FONT)}
            title="Reset font size"
            className="w-9 rounded-sm text-center text-micro text-quaternary tnum transition-colors hover:bg-[var(--fill-tertiary)] hover:text-secondary"
          >
            {terminal.fontSize}px
          </button>
          <IconButton
            size="sm"
            icon="zoomIn"
            label="Increase font size"
            disabled={terminal.fontSize >= MAX_FONT}
            onClick={() => zoom(terminal.fontSize + 1)}
          />
          <IconButton
            size="sm"
            icon="search"
            label="Find in terminal"
            selected={findOpen}
            onClick={() => setFindOpen((open) => !open)}
          />
          <Menu
            align="end"
            trigger={<IconButton size="sm" icon="ellipsis" label="Terminal actions" />}
          >
            <MenuItem icon="sliders" onClick={() => actions.openSettings("terminal")}>
              Terminal settings…
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="trash" onClick={() => setCleared(true)}>
              Clear
            </MenuItem>
            <MenuItem
              icon="refresh"
              onClick={() => {
                setCleared(false);
                setEpoch((n) => n + 1);
              }}
            >
              Restart
            </MenuItem>
          </Menu>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={measure}
          className="ink-scroll h-full overflow-auto bg-canvas p-3"
        >
          <div
            className="relative select-text text-[var(--term-default)]"
            style={{
              fontFamily: `"${terminal.fontFamily}", var(--font-mono)`,
              fontSize: terminal.fontSize,
              lineHeight: `${rowH}px`,
              letterSpacing: 0,
              fontVariantLigatures: "none",
              height: (body.length + 1) * rowH,
              minWidth: "max-content",
            }}
          >
            <div
              className="absolute inset-x-0"
              style={{ top: Math.min(win.start, body.length) * rowH }}
            >
              {body
                .slice(Math.min(win.start, body.length), Math.min(win.end, body.length))
                .map((line, index) => {
                  const at = Math.min(win.start, body.length) + index;
                  return paintLine(line, `l${at}`, prefix[at]!);
                })}
            </div>
            <div className="absolute inset-x-0" style={{ top: body.length * rowH }}>
              {paintLine(
                live,
                "live",
                prefix[prefix.length - 1]!,
                <Cursor style={terminal.cursorStyle} />,
              )}
            </div>
          </div>
        </div>

        {findOpen && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-card bg-canvas p-1 e2">
            <Input
              ref={findInputRef}
              size="sm"
              icon="search"
              value={query}
              placeholder="Find"
              aria-label="Find in terminal"
              className="w-48"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  step(event.shiftKey ? -1 : 1);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setFindOpen(false);
                }
              }}
            />
            <span className="w-20 shrink-0 whitespace-nowrap text-center text-micro text-tertiary tnum">
              {needle === "" ? "" : total === 0 ? "No results" : `${current + 1} / ${total}`}
            </span>
            <IconButton
              size="sm"
              icon="chevronUp"
              label="Previous match"
              disabled={total === 0}
              onClick={() => step(-1)}
            />
            <IconButton
              size="sm"
              icon="chevronDown"
              label="Next match"
              disabled={total === 0}
              onClick={() => step(1)}
            />
            <IconButton size="sm" icon="close" label="Close find" onClick={() => setFindOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
