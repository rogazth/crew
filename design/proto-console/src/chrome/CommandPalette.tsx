import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fuzzyMatch,
  highlightRuns,
  listedCommands,
  roleLabel,
  snippetRuns,
  type CommandId,
  type SearchHit,
  type SessionStatus,
} from "@crew/fixtures";
import { Dialog, Kbd, ProviderMark, StatusMark, TerminalMark } from "@/ui";
import { store, useApp, type PaletteFilter } from "@/lib/store";
import { ACTIONS } from "@/lib/commands";
import { useSearchHits } from "@/lib/search";
import { rankFiles } from "@/lib/files";
import { fileName } from "@/lib/format";

const FILTERS: Array<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
];

type Item = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  mark?: ReactNode;
  status?: SessionStatus;
  kbd?: string;
  runs: ReactNode;
  run: () => void;
};

/** `>` actions · `@` agents · `#` messages · `:` line — prefix routing, vim style. */
const PREFIXES: Record<string, PaletteFilter | "messages" | "line"> = {
  ">": "actions",
  "@": "agents",
  "#": "messages",
  ":": "line",
};

export function CommandPalette() {
  const state = useApp();
  const open = state.overlay?.kind === "palette";
  const seeded = state.overlay?.kind === "palette" ? state.overlay.seed : "";
  const startFilter = state.overlay?.kind === "palette" ? state.overlay.filter : "all";
  const [query, setQuery] = useState(seeded);
  const [filter, setFilter] = useState<PaletteFilter>(startFilter);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(seeded);
    setFilter(startFilter);
    setCursor(0);
  }, [open, seeded, startFilter]);

  const prefix = query[0] && PREFIXES[query[0]] ? query[0]! : null;
  const routed = prefix ? PREFIXES[prefix]! : null;
  const text = prefix ? query.slice(1) : query;
  const effective: PaletteFilter | "messages" | "line" = routed ?? filter;

  // Message search is the one route the source answers asynchronously.
  const { hits } = useSearchHits(
    open && effective === "messages" && text.trim() ? { query: text, limit: 30 } : null,
  );

  const items = useMemo(
    () => buildItems(effective, text, state, hits),
    // `state` is the whole store; the palette is cheap and only open on demand.
    [effective, text, state, hits],
  );

  useEffect(() => {
    setCursor(0);
  }, [query, filter]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, items.length]);

  const close = () => store.closeOverlay();

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCursor((held) => (items.length === 0 ? 0 : (((held + delta) % items.length) + items.length) % items.length));
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const at = FILTERS.findIndex((f) => f.id === filter);
      const delta = event.shiftKey ? -1 : 1;
      const next = FILTERS[(((at + delta) % FILTERS.length) + FILTERS.length) % FILTERS.length]!;
      setFilter(next.id);
      if (prefix) setQuery(text);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[cursor];
      if (item) {
        close();
        item.run();
      }
    }
  };

  let group = "";

  return (
    <Dialog open={open} onClose={close} label="Command palette" top className="max-w-[640px]">
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-rule px-3">
        <span className="shrink-0 font-mono text-md text-ink-4">{prefix ?? "›"}</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholderFor(effective)}
          aria-label="Command palette"
          className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-ink-4"
        />
        <div className="flex shrink-0 items-center gap-px">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setFilter(entry.id);
                if (prefix) setQuery(text);
              }}
              className={clsx(
                "rounded-[var(--r)] px-1.5 py-0.5 font-mono text-xs transition-colors duration-[var(--fast)]",
                (routed ?? filter) === entry.id ? "bg-ink text-on-ink" : "text-ink-4 hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} className="scroll min-h-0 flex-1 py-1" role="listbox" aria-label="Results">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-md text-ink-4">Nothing matches.</p>
        ) : null}
        {items.map((item, index) => {
          const header = item.group !== group ? item.group : null;
          group = item.group;
          return (
            <div key={item.id}>
              {header ? (
                <div className="px-3 pt-2 pb-1 font-mono text-xs tracking-wide text-ink-4 uppercase">
                  {header}
                </div>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={index === cursor}
                data-cursor={index === cursor}
                onMouseMove={() => setCursor(index)}
                onClick={() => {
                  close();
                  item.run();
                }}
                className={clsx(
                  "flex h-[var(--row-h)] w-full items-center gap-2 px-3 text-left",
                  index === cursor ? "bg-raised" : "",
                )}
              >
                {item.mark ? <span className="shrink-0">{item.mark}</span> : null}
                <span className="truncate text-md text-ink">{item.runs}</span>
                {item.detail ? (
                  <span className="min-w-0 truncate font-mono text-xs text-ink-4">{item.detail}</span>
                ) : null}
                <span className="ml-auto shrink-0 pl-2">
                  {item.status ? <StatusMark status={item.status} /> : null}
                  {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
                </span>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-rule px-3 py-1.5 font-mono text-xs text-ink-4">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd> Select
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⏎</Kbd> Open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⇥</Kbd> Change filter
        </span>
        <span className="ml-auto">{items.length} results</span>
      </div>
    </Dialog>
  );
}

function placeholderFor(filter: PaletteFilter | "messages" | "line"): string {
  switch (filter) {
    case "agents":
      return "Jump to an agent…";
    case "sessions":
      return "Jump to a session…";
    case "files":
      return "Go to file…";
    case "actions":
      return "Run an action…";
    case "messages":
      return "Search every message…";
    case "line":
      return "Go to line…";
    default:
      return "Search sessions, files and actions…";
  }
}

function runsOf(label: string, query: string): ReactNode {
  const hit = query ? fuzzyMatch(query, label) : null;
  if (!hit) return label;
  return highlightRuns(label, hit.positions).map((run, index) =>
    run.hit ? (
      <span key={index} className="text-accent-ink">
        {run.text}
      </span>
    ) : (
      <span key={index}>{run.text}</span>
    ),
  );
}

function buildItems(
  filter: PaletteFilter | "messages" | "line",
  query: string,
  state: ReturnType<typeof useApp>,
  hits: SearchHit[],
): Item[] {
  const items: Item[] = [];
  const push = (item: Item) => items.push(item);

  const sessionItem = (id: string): Item | null => {
    const session = state.sessions.find((s) => s.id === id);
    if (!session) return null;
    return {
      id: `session-${session.id}`,
      group: session.kind === "agent" ? "Agents" : "Sessions",
      label: session.name,
      detail: session.kind === "agent" ? session.description : "terminal",
      mark:
        session.kind === "terminal" ? <TerminalMark /> : <ProviderMark provider={session.provider} />,
      status: session.status,
      runs: runsOf(session.name, query),
      run: () => store.openSession(session.id),
    };
  };

  if (filter === "line") {
    const tab = store.activeTab;
    const line = Number.parseInt(query, 10);
    if (tab?.kind === "file" && Number.isFinite(line)) {
      push({
        id: "line",
        group: "Go to line",
        label: `${tab.relative}:${line}`,
        runs: `${tab.relative}:${line}`,
        run: () => store.openFile(tab.relative, line),
      });
    }
    return items;
  }

  if (filter === "messages") {
    if (!query.trim()) {
      push({
        id: "search-page",
        group: "Messages",
        label: "Open the search page",
        kbd: "⌘⇧F",
        runs: "Open the search page",
        run: () => store.openSearch(""),
      });
      return items;
    }
    for (const hit of hits) {
      push({
        id: `hit-${hit.sessionId}-${hit.id}`,
        group: "Messages",
        label: hit.sessionName,
        detail: roleLabel(hit.role),
        runs: (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">{hit.sessionName}</span>
            <span className="truncate font-mono text-sm text-ink-3">
              {snippetRuns(hit.snippet).map((run, index) =>
                run.hit ? (
                  <mark key={index} className="bg-mark text-ink">
                    {run.text}
                  </mark>
                ) : (
                  <span key={index}>{run.text}</span>
                ),
              )}
            </span>
          </span>
        ),
        run: () => store.scrollTo(hit.sessionId, hit.id),
      });
    }
    return items;
  }

  const wantSessions = filter === "all" || filter === "agents" || filter === "sessions";
  const wantFiles = filter === "all" || filter === "files";
  const wantActions = filter === "all" || filter === "actions";

  if (wantSessions) {
    const pool = state.sessions.filter((session) => {
      if (filter === "agents") return session.kind === "agent";
      if (filter === "sessions") return true;
      return true;
    });
    const scored = query
      ? pool
          .map((session) => ({ session, hit: fuzzyMatch(query, session.name) }))
          .filter((entry) => entry.hit)
          .sort((a, b) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0))
          .map((entry) => entry.session)
      : [...pool].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, filter === "all" ? 5 : 40);
    for (const session of scored) {
      const item = sessionItem(session.id);
      if (item) push(item);
    }
  }

  if (wantFiles) {
    const scored = query
      ? rankFiles(query, filter === "all" ? 6 : 60)
      : filter === "files"
        ? state.files.slice(0, 40)
        : [];
    for (const file of scored) {
      push({
        id: `file-${file.relative}`,
        group: "Files",
        label: file.relative,
        detail: file.relative.replace(/\/[^/]+$/, ""),
        mark: (
          <span className="grid size-[14px] place-items-center rounded-[var(--r)] bg-sunken font-mono text-[8px] leading-none text-ink-3">
            {file.relative.split(".").pop()?.slice(0, 2)}
          </span>
        ),
        runs: runsOf(fileName(file.relative), query),
        run: () => store.openFile(file.relative),
      });
    }
  }

  if (wantActions) {
    const all = listedCommands();
    const scored = query
      ? all
          .map((command) => ({ command, hit: fuzzyMatch(query, command.label) }))
          .filter((entry) => entry.hit)
          .sort((a, b) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0))
          .map((entry) => entry.command)
      : all.slice(0, filter === "all" ? 5 : all.length);
    for (const command of scored) {
      push({
        id: `action-${command.id}`,
        group: "Actions",
        label: command.label,
        kbd: command.keys,
        runs: runsOf(command.label, query),
        run: () => ACTIONS[command.id as CommandId]?.(),
      });
    }
  }

  return items;
}
