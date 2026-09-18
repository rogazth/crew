import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Segment, TerminalLine, Tone } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { source } from "@/lib/source";
import { useStore } from "@/lib/store";
import { IconButton } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Pulse } from "@/ui/Pulse";

const TONE: Record<Tone, string> = {
  default: "text-code-ink",
  dim: "text-ink-38",
  prompt: "text-[var(--ok)]",
  path: "text-[var(--syn-type)] underline decoration-dotted underline-offset-2 cursor-pointer",
  ok: "text-[var(--ok)]",
  warn: "text-[var(--warn)]",
  error: "text-[var(--danger)]",
  accent: "text-accent-text",
  added: "text-[var(--added-ink)]",
  removed: "text-[var(--removed-ink)]",
};

const PATH_HINT = /^[\w./-]+\.(ts|tsx|rs|css|json|md|js)(:\d+(:\d+)?)?$/;
const OVERSCAN = 20;

export function TerminalSurface({ sessionId, title }: { sessionId: string; title: string }) {
  const { terminalPrefs, openFile, setPage } = useStore();
  const [buffer, setBuffer] = useState<TerminalLine[] | null>(null);
  const [find, setFind] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [top, setTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setBuffer(null);
    void source.terminal(sessionId).then((lines) => alive && setBuffer(lines));
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const lines = buffer ?? [];
  const lineHeight = Math.round(terminalPrefs.fontSize * 1.55);

  const matches = useMemo(() => {
    if (!query.trim()) return [];
    const needle = query.toLowerCase();
    const out: number[] = [];
    lines.forEach((line, index) => {
      const text = line.map((segment) => segment.text).join("").toLowerCase();
      if (text.includes(needle)) out.push(index);
    });
    return out;
  }, [lines, query]);

  useEffect(() => {
    const onEvent = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "find") {
        setFind("");
        requestAnimationFrame(() => document.getElementById("terminal-find")?.focus());
      }
    };
    window.addEventListener("canvas:terminal", onEvent);
    return () => window.removeEventListener("canvas:terminal", onEvent);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) setViewport(el.clientHeight);
  }, [buffer]);

  // The row may not be mounted — the body is windowed — so scroll by arithmetic
  // rather than by looking the element up.
  useEffect(() => {
    if (matches.length === 0) return;
    const index = matches[hit % matches.length] ?? 0;
    bodyRef.current?.scrollTo({ top: Math.max(0, index * lineHeight - viewport / 2) });
  }, [hit, matches, lineHeight, viewport]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setHit((held) => (held + delta + matches.length) % matches.length);
  };

  const active = matches.length > 0 ? matches[hit % matches.length] : -1;
  const first = Math.max(0, Math.floor(top / lineHeight) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((top + viewport) / lineHeight) + OVERSCAN);
  const rows = lines.slice(first, last);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-term-bg">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--line-soft)] px-4">
        <Icon name="terminal" size={14} className="text-ink-38" />
        <span className="flex-1 truncate text-sm text-ink-70">{title}</span>
        {lines.length > 2_000 && (
          <span className="text-xs tabular-nums text-ink-38">{lines.length.toLocaleString()} lines</span>
        )}
        <span className="text-xs text-ink-38">{terminalPrefs.fontSize}px</span>
        <IconButton icon="search" label="Find in terminal" size="sm" variant="ghost" onClick={() => setFind("")} />
        <IconButton
          icon="settings"
          label="Terminal settings"
          size="sm"
          variant="ghost"
          onClick={() => setPage({ kind: "settings", section: "terminal" })}
        />
      </header>

      {find !== null && (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--line-soft)] bg-sunken px-4">
          <Input
            id="terminal-find"
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              setHit(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
              if (event.key === "Escape") {
                setFind(null);
                setQuery("");
              }
            }}
            placeholder="Find"
            className="h-7 max-w-[280px]"
            leading={<Icon name="search" size={13} className="text-ink-38" />}
          />
          <span className="text-sm tabular-nums text-ink-52">
            {matches.length === 0 ? (query ? "No results" : "") : `${(hit % matches.length) + 1} of ${matches.length}`}
          </span>
          <IconButton icon="chevronUp" label="Previous match" size="sm" variant="ghost" onClick={() => step(-1)} />
          <IconButton icon="chevronDown" label="Next match" size="sm" variant="ghost" onClick={() => step(1)} />
          <span className="flex-1" />
          <IconButton
            icon="x"
            label="Close find"
            size="sm"
            variant="ghost"
            onClick={() => {
              setFind(null);
              setQuery("");
            }}
          />
        </div>
      )}

      <div
        ref={bodyRef}
        onScroll={(event) => {
          setTop(event.currentTarget.scrollTop);
          setViewport(event.currentTarget.clientHeight);
        }}
        className="scroller min-h-0 flex-1 px-4 py-3 font-mono"
        style={{ fontFamily: terminalPrefs.fontFamily, fontSize: terminalPrefs.fontSize, lineHeight: `${lineHeight}px` }}
      >
        {buffer === null ? (
          <span className="flex items-center gap-2 text-ink-38">
            <Pulse />
            attaching
          </span>
        ) : (
          <div className="relative" style={{ height: (lines.length + 1) * lineHeight }}>
            <div className="absolute inset-x-0" style={{ transform: `translateY(${first * lineHeight}px)` }}>
              {rows.map((line, offset) => {
                const index = first + offset;
                return (
                  <div
                    key={index}
                    data-line={index}
                    style={{ height: lineHeight }}
                    className={cx("whitespace-pre", index === active && "rounded-[4px] bg-accent-soft")}
                  >
                    <TerminalRow line={line} query={query} onPath={(path) => openFile(path.split(":")[0]!)} />
                  </div>
                );
              })}
              {last >= lines.length && (
                <div className="flex items-center gap-0" style={{ height: lineHeight }}>
                  <span className="text-[var(--ok)]">➜</span>
                  <span className="mx-2 text-accent-text">crew</span>
                  <Cursor style={terminalPrefs.cursor} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalRow({
  line,
  query,
  onPath,
}: {
  line: TerminalLine;
  query: string;
  onPath: (path: string) => void;
}) {
  return (
    <>
      {line.map((segment: Segment, index: number) => {
        const tone = segment.tone ?? "default";
        const clickable = tone === "path" || PATH_HINT.test(segment.text.trim());
        if (clickable) {
          return (
            <span
              key={index}
              role="link"
              tabIndex={0}
              onClick={() => onPath(segment.text.trim())}
              onKeyDown={(event) => event.key === "Enter" && onPath(segment.text.trim())}
              className={TONE.path}
            >
              {segment.text}
            </span>
          );
        }
        return (
          <span key={index} className={TONE[tone]}>
            {query && segment.text.toLowerCase().includes(query.toLowerCase())
              ? mark(segment.text, query)
              : segment.text}
          </span>
        );
      })}
    </>
  );
}

function mark(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-[3px] bg-[var(--mark-bg)] text-[var(--mark-ink)]">
        {text.slice(at, at + query.length)}
      </span>
      {text.slice(at + query.length)}
    </>
  );
}

export function Cursor({ style }: { style: "block" | "bar" | "underline" }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block bg-accent",
        style === "block" && "h-[1.1em] w-[0.6em] align-text-bottom",
        style === "bar" && "h-[1.1em] w-[2px] align-text-bottom",
        style === "underline" && "h-[2px] w-[0.6em] align-bottom",
      )}
      style={{ animation: "canvas-pulse 1.2s steps(1, end) infinite" }}
    />
  );
}
