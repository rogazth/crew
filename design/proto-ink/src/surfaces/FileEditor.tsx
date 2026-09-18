import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { diffs } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useBus } from "@/lib/bus";
import { SOURCE } from "@/lib/source";
import { Icon } from "@/lib/icon";
import { Badge, Button, Kbd, Segmented } from "@/ui";
import { fileIcon, isLargeFile } from "@/lib/files";
import { highlightCached, langOfPath, type Line } from "@/lib/highlight";
import { DiffView } from "./DiffView";

const ROW = 18;
const OVERSCAN = 20;
const REHIGHLIGHT_MS = 120;

/**
 * The tab bar owns the unsaved dot on the tab itself, so the flag has to outlive
 * this component. The shell reads it by relative path.
 */
export const dirtyFiles = new Map<string, boolean>();

/** The mirror and the textarea must agree to the pixel, so they share one style. */
const CODE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-small)",
  lineHeight: `${ROW}px`,
  letterSpacing: 0,
  fontVariantLigatures: "none",
  whiteSpace: "pre",
  tabSize: 2,
  padding: "0 12px",
  border: 0,
  margin: 0,
};

function countLines(text: string, end = text.length): number {
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < end; i = text.indexOf("\n", i + 1)) n += 1;
  return n;
}

const CodeLine = memo(function CodeLine({ tokens, text }: { tokens: Line | null; text: string }) {
  return (
    <div style={{ height: ROW }}>
      {tokens === null
        ? text
        : tokens.map((token, i) => (
            <span key={i} className={`tok-${token.cls}`}>
              {token.text}
            </span>
          ))}
    </div>
  );
});

export function FileEditor({ relative, path }: { relative: string; path: string }) {
  const [initial, setInitial] = useState("");
  const [text, setText] = useState("");
  const [mirror, setMirror] = useState("");
  const [loading, setLoading] = useState(true);

  // The body is a request now, not a lookup: a live source reads it off disk.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void SOURCE.readTextFile(path).then((body) => {
      if (!alive) return;
      setInitial(body);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [view, setView] = useState<"file" | "changes">("file");
  const [active, setActive] = useState(0);
  const [win, setWin] = useState({ start: 0, end: 80 });

  const scroller = useRef<HTMLDivElement | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const savedTimer = useRef<number | null>(null);

  const fixture = useMemo(() => diffs.find((entry) => entry.path === relative), [relative]);
  const lang = useMemo(() => langOfPath(relative), [relative]);

  useEffect(() => {
    setText(initial);
    setMirror(initial);
    setDirty(false);
    setSaved(false);
    setActive(0);
    setView("file");
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [initial]);

  // The mirror lags the caret by one debounce window while typing. Every real
  // editor does this; re-tokenising on each keystroke is what it buys back.
  useEffect(() => {
    if (text === mirror) return;
    const id = window.setTimeout(() => setMirror(text), REHIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [text, mirror]);

  useEffect(() => () => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
  }, []);

  const large = useMemo(() => isLargeFile(mirror), [mirror]);
  const lines = useMemo(() => mirror.split("\n"), [mirror]);
  const total = useMemo(() => countLines(text), [text]);
  const widest = useMemo(() => {
    let max = 0;
    for (const line of lines) if (line.length > max) max = line.length;
    return max;
  }, [lines]);

  const highlighted = useMemo<Line[] | null>(
    () => (large ? null : highlightCached(relative, mirror, lang)),
    [large, relative, mirror, lang],
  );

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / ROW) - OVERSCAN);
    const end = Math.ceil((el.scrollTop + el.clientHeight) / ROW) + OVERSCAN;
    setWin((held) => (held.start === start && held.end === end ? held : { start, end }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, view]);

  const save = useCallback(() => {
    if (!dirty) return;
    void SOURCE.writeTextFile(path, text);
    dirtyFiles.set(relative, false);
    setDirty(false);
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1400);
  }, [dirty, relative, path, text]);

  // ⌘S belongs to whatever has focus, so the surface binds it locally; the
  // palette's "Save File" reaches the same handler through the bus.
  useBus("file:save", save);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  };

  const syncCaret = useCallback(() => {
    const el = area.current;
    if (!el) return;
    setActive(countLines(el.value, el.selectionStart) - 1);
  }, []);

  const start = Math.min(win.start, Math.max(0, total - 1));
  const end = Math.min(total, win.end);
  const visible = lines.slice(start, end);
  // The gutter counts the live text; the mirror lags it by one debounce window,
  // so it cannot be the thing that decides how many numbers there are.
  const rows = Array.from({ length: Math.max(0, end - start) });
  const height = total * ROW;
  const digits = String(Math.max(total, 1)).length;
  // The numbers are positioned absolutely so they can be windowed, which means
  // they contribute no width; the column has to be measured, not inferred.
  const gutter = `calc(${digits}ch + 16px)`;

  const dir = relative.slice(0, relative.lastIndexOf("/") + 1);
  const base = relative.slice(dir.length);

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas" onKeyDown={onKeyDown}>
      <header
        className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--stroke-tertiary)] bg-chrome px-2"
        title={path}
      >
        <Icon name={fileIcon(relative)} size={14} className="shrink-0 text-icon-faint" />
        <span className="ink-mono min-w-0 truncate">
          <span className="text-tertiary">{dir}</span>
          <span className="text-primary">{base}</span>
        </span>
        <span
          aria-hidden={!dirty}
          className={cx(
            "size-1.5 shrink-0 rounded-full bg-[var(--status-attention)]",
            "transition-opacity duration-[var(--dur-2)]",
            dirty ? "opacity-100" : "opacity-0",
          )}
        />
        {loading && <Badge>reading…</Badge>}
        {!loading && large && <Badge>plain text</Badge>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {fixture && (
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "file", label: "File" },
                { value: "changes", label: "Changes" },
              ]}
            />
          )}
          {/* Reserved so "Saved" never nudges the toolbar. */}
          <span className="w-10 text-right text-micro text-tertiary">{saved ? "Saved" : ""}</span>
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty}
            trailing={<Kbd className="ml-1">⌘S</Kbd>}
          >
            Save
          </Button>
        </div>
      </header>

      {view === "changes" && fixture ? (
        <div className="ink-scroll min-h-0 flex-1 overflow-y-auto p-3">
          <DiffView patch={fixture.patch} path={relative} />
        </div>
      ) : (
        <div
          ref={scroller}
          onScroll={measure}
          className="ink-scroll relative min-h-0 flex-1 overflow-auto"
        >
          <div className="flex py-2">
            <div
              className="sticky left-0 z-[2] shrink-0 select-none border-r border-[var(--stroke-tertiary)] bg-canvas"
              style={{ height, width: gutter }}
            >
              <div className="relative" style={{ height, width: gutter }}>
                <div
                  className="absolute inset-x-0 tnum text-quaternary"
                  style={{ ...CODE, top: start * ROW, padding: "0 8px", textAlign: "right" }}
                >
                  {rows.map((_, i) => (
                    <div
                      key={start + i}
                      style={{ height: ROW, minWidth: `${digits}ch` }}
                      className={start + i === active ? "text-secondary" : undefined}
                    >
                      {start + i + 1}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              className="relative"
              style={{ height, minWidth: "100%", width: `calc(${widest}ch + 24px)` }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute right-0 left-0 bg-[var(--fill-quaternary)]"
                style={{ top: active * ROW, height: ROW }}
              />
              <pre
                aria-hidden
                className="absolute right-0 left-0 text-primary"
                style={{ ...CODE, top: start * ROW }}
              >
                {visible.map((line, i) => (
                  <CodeLine
                    key={start + i}
                    text={line}
                    tokens={highlighted ? (highlighted[start + i] ?? []) : null}
                  />
                ))}
              </pre>
              <textarea
                ref={area}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setDirty(true);
                  dirtyFiles.set(relative, true);
                  setSaved(false);
                }}
                onSelect={syncCaret}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                wrap="off"
                aria-label={relative}
                className="absolute inset-0 resize-none overflow-hidden outline-none"
                style={{
                  ...CODE,
                  color: "transparent",
                  caretColor: "var(--text-primary)",
                  background: "transparent",
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
