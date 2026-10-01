import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaseSensitiveIcon, ChevronRightIcon, EllipsisIcon, RegexIcon, WholeWordIcon, type LucideIcon } from "lucide-react";
import { FileTypeIcon } from "../FileTypeIcon";
import { TextInput } from "../kit";
import { useVirtualRows } from "../../hooks/useVirtualRows";
import * as api from "../../lib/api";
import type { FileMatches, FileSearchResult, LineMatch } from "../../lib/protocol";
import { requestReveal } from "../../lib/reveal";
import { previewRuns } from "../../lib/searchPreview";
import type { ProjectFile } from "../../lib/types";

type Props = {
  root: string;
  /** A new token puts the keyboard in the box; `query` fills it, as a selection does in VS Code. */
  focus: { token: number; query?: string } | null;
  onOpenFile: (file: ProjectFile) => void;
};

type Answer = { key: string } & ({ result: FileSearchResult; error: null } | { result: null; error: string });

type Row = { kind: "file"; file: FileMatches } | { kind: "line"; file: FileMatches; line: LineMatch };

const ROW = 28;
/** Long enough that a held key does not start a search per character. */
const DEBOUNCE_MS = 150;

const count = new Intl.NumberFormat();

/** Text in the workspace's files, VS Code's ⌘⇧F: the daemon searches, this lists what it found. */
export function SearchPanel({ root, focus, onOpenFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Mounted by the shortcut itself when the explorer was closed: the token is new, and so is the text.
  const [query, setQuery] = useState(focus?.query ?? "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [details, setDetails] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  // Answers can land out of order; only the newest may paint.
  const latest = useRef(0);

  // A shortcut with text selected brings the text: taken as the token changes, during render.
  const [seen, setSeen] = useState(focus?.token);
  if (focus && focus.token !== seen) {
    setSeen(focus.token);
    if (focus.query !== undefined) setQuery(focus.query);
  }
  useEffect(() => {
    if (!focus) return;
    input.current?.focus();
    input.current?.select();
  }, [focus]);

  const text = query.trim() === "" ? "" : query;
  const request = useMemo(
    () => ({ cwd: root, query: text, caseSensitive, wholeWord, regex, include, exclude }),
    [root, text, caseSensitive, wholeWord, regex, include, exclude],
  );
  const key = JSON.stringify(request);
  useEffect(() => {
    const ticket = latest.current + 1;
    latest.current = ticket;
    if (request.query === "") return;
    const timer = window.setTimeout(() => {
      api
        .searchFiles(request)
        .then((result) => {
          if (latest.current !== ticket || result.cancelled) return;
          setAnswer({ key: JSON.stringify(request), result, error: null });
          setCollapsed(new Set());
          setCursor(-1);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (latest.current === ticket) setAnswer({ key: JSON.stringify(request), result: null, error: message });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [request]);

  // An empty box shows nothing; a new query keeps the last answer up until its own lands.
  const shown = text === "" ? null : answer;
  const searching = text !== "" && answer?.key !== key;
  const rows = useMemo<Row[]>(
    () =>
      (shown?.result?.files ?? []).flatMap((file) => [
        { kind: "file" as const, file },
        ...(collapsed.has(file.path) ? [] : file.lines.map((line) => ({ kind: "line" as const, file, line }))),
      ]),
    [shown, collapsed],
  );
  const { start, end, total, scrollToIndex } = useVirtualRows(list, rows.length, ROW);

  useEffect(() => {
    if (cursor >= 0) scrollToIndex(cursor);
  }, [cursor, scrollToIndex]);

  function toggleFile(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function open(row: Row) {
    if (row.kind === "file") {
      toggleFile(row.file.path);
      return;
    }
    const [from, to] = row.line.ranges[0] ?? [0, 0];
    requestReveal(row.file.path, { line: row.line.line, from, to });
    const name = row.file.relative.split("/").pop() ?? row.file.relative;
    onOpenFile({ path: row.file.path, relative: row.file.relative, name });
  }

  function onInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowDown" || rows.length === 0) return;
    event.preventDefault();
    setCursor(Math.max(cursor, 0));
    list.current?.focus();
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    const row = rows[cursor];
    switch (event.key) {
      case "ArrowDown":
        setCursor((current) => Math.min(rows.length - 1, current + 1));
        break;
      case "ArrowUp":
        if (cursor <= 0) {
          input.current?.focus();
          break;
        }
        setCursor((current) => current - 1);
        break;
      case "ArrowLeft":
        if (row?.kind === "line") setCursor(rows.findIndex((other) => other.kind === "file" && other.file === row.file));
        else if (row && !collapsed.has(row.file.path)) toggleFile(row.file.path);
        break;
      case "ArrowRight":
        if (row?.kind === "file" && collapsed.has(row.file.path)) toggleFile(row.file.path);
        break;
      case "Enter":
        if (row) open(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const result = shown?.result;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2 pb-1.5">
        <div className="flex items-center gap-1">
          {/* The kit's TextInput, with the flags inside it as VS Code has them. */}
          <div className="flex h-8 min-w-0 flex-1 items-center rounded-md bg-canvas pr-1 ring ring-border transition-shadow focus-within:ring-[1.5px] focus-within:ring-focus/50">
            <input
              ref={input}
              aria-label="Search in files"
              placeholder="Search"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
              className="h-full min-w-0 flex-1 bg-transparent px-2.5 outline-none placeholder:text-placeholder"
            />
            <Flag icon={CaseSensitiveIcon} label="Match case" on={caseSensitive} onChange={setCaseSensitive} />
            <Flag icon={WholeWordIcon} label="Match whole word" on={wholeWord} onChange={setWholeWord} />
            <Flag icon={RegexIcon} label="Use regular expression" on={regex} onChange={setRegex} />
          </div>
          <Flag icon={EllipsisIcon} label="Files to include or exclude" on={details} onChange={setDetails} />
        </div>
        {details && (
          <>
            <Globs label="Files to include" placeholder="e.g. src, *.ts" value={include} onChange={setInclude} />
            <Globs label="Files to exclude" placeholder="e.g. *.test.ts, docs" value={exclude} onChange={setExclude} />
          </>
        )}
        <Summary searching={searching} error={shown?.error ?? null} result={result ?? null} empty={text === ""} />
      </div>
      <div
        ref={list}
        role="tree"
        aria-label="Search results"
        tabIndex={rows.length > 0 ? 0 : -1}
        aria-activedescendant={cursor >= 0 ? `search-row-${cursor}` : undefined}
        onKeyDown={onListKey}
        className="group/results min-h-0 flex-1 overflow-y-auto pb-2 outline-none"
      >
        <div style={{ height: total }} className="relative">
          {rows.slice(start, end).map((row, offset) => {
            const index = start + offset;
            return (
              <div
                key={row.kind === "file" ? row.file.path : `${row.file.path}:${row.line.line}`}
                id={`search-row-${index}`}
                role="treeitem"
                aria-level={row.kind === "file" ? 1 : 2}
                aria-expanded={row.kind === "file" ? !collapsed.has(row.file.path) : undefined}
                data-cursor={index === cursor || undefined}
                onClick={() => {
                  setCursor(index);
                  open(row);
                }}
                style={{ top: index * ROW, height: ROW }}
                className="absolute inset-x-1.5 flex items-center gap-1.5 rounded-chrome pr-2 hover:bg-hover group-focus-visible/results:data-cursor:bg-hover group-focus-visible/results:data-cursor:ring-1 group-focus-visible/results:data-cursor:ring-border-strong"
              >
                {row.kind === "file" ? (
                  <FileRow file={row.file} open={!collapsed.has(row.file.path)} />
                ) : (
                  <LineRow line={row.line} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FileRow({ file, open }: { file: FileMatches; open: boolean }) {
  const cut = file.relative.lastIndexOf("/");
  const name = file.relative.slice(cut + 1);
  const folder = cut > 0 ? file.relative.slice(0, cut) : "";
  const matches = file.lines.reduce((sum, line) => sum + line.ranges.length, 0);
  return (
    <>
      <ChevronRightIcon
        className={`ml-1.5 size-3.5 shrink-0 text-icon transition-transform duration-100 ${open ? "rotate-90" : ""}`}
      />
      <FileTypeIcon name={name} />
      <span className="shrink-0 truncate">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted" title={file.relative}>
        {folder}
      </span>
      <span className="shrink-0 rounded-full bg-fill px-1.5 text-[11px] text-text-muted tabular-nums">{matches}</span>
    </>
  );
}

function LineRow({ line }: { line: LineMatch }) {
  return (
    <span className="min-w-0 flex-1 truncate pl-9 text-text/85" title={`Line ${line.line}`}>
      {previewRuns(line).map((run, index) =>
        run.hit ? (
          <mark key={index} className="rounded-[2px] bg-find text-text">
            {run.text}
          </mark>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </span>
  );
}

function Summary({
  searching,
  error,
  result,
  empty,
}: {
  searching: boolean;
  error: string | null;
  result: FileSearchResult | null;
  empty: boolean;
}) {
  let text: ReactNode = null;
  if (error) text = <span className="text-danger">{error}</span>;
  else if (empty) text = null;
  else if (result && result.files.length === 0) text = searching ? "Searching…" : "No results.";
  else if (result) {
    const files = result.files.length;
    text = `${count.format(result.matches)} ${result.matches === 1 ? "result" : "results"} in ${count.format(files)} ${
      files === 1 ? "file" : "files"
    }${result.truncated ? ". There are more: narrow the search to see them." : ""}`;
  } else if (searching) text = "Searching…";
  if (!text) return null;
  return (
    <p aria-live="polite" className="truncate px-0.5 text-[12px] text-text-muted">
      {text}
    </p>
  );
}

function Flag({
  icon: Glyph,
  label,
  on,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className="grid size-6 shrink-0 place-items-center rounded-[5px] text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 aria-pressed:bg-selected aria-pressed:text-text"
    >
      <Glyph className="size-4" />
    </button>
  );
}

function Globs({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="px-0.5 text-[11px] text-text-muted">{label}</span>
      <TextInput placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
