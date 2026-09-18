import { useEffect, useMemo, useRef, useState } from "react";
import {
  listedCommands,
  providerLine,
  rankBy,
  type CommandId,
  type SessionStatus,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore, type PaletteFilter } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Modal } from "@/ui/Dialog";
import { StatusDot } from "./StatusDot";

const FILTERS: Array<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
];

type Row = {
  key: string;
  group: string;
  label: string;
  detail?: string;
  icon?: GlyphName;
  seed?: string;
  status?: SessionStatus;
  keys?: string;
  run: () => void;
};

export function CommandPalette({ onCommand }: { onCommand: (id: CommandId) => void }) {
  const store = useStore();
  const { palette, setPalette, wsSessions, statusOf, openSession, openFile, files } = store;
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const open = palette !== null;
  const filter: PaletteFilter = palette ?? "all";

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open, palette]);

  // A leading ">" is the Actions door, the way the user already expects.
  const effective: PaletteFilter = query.startsWith(">") ? "actions" : filter;
  const needle = query.startsWith(">") ? query.slice(1).trim() : query.trim();

  const rows = useMemo<Row[]>(() => {
    const sessionRows = (kindFilter: (kind: string) => boolean): Row[] =>
      wsSessions
        .filter((session) => kindFilter(session.kind))
        .map((session) => ({
          key: `session:${session.id}`,
          group: session.kind === "terminal" ? "Terminals" : "Agents",
          label: session.name,
          detail:
            session.kind === "terminal" ? session.description || "shell" : providerLine(session.provider, session.model),
          seed: session.kind === "agent" ? session.name : undefined,
          icon: session.kind === "terminal" ? "terminal" : undefined,
          status: statusOf(session.id),
          run: () => openSession(session.id),
        }));

    const fileRows: Row[] = files.map((file) => ({
      key: `file:${file.relative}`,
      group: "Files",
      label: file.name,
      detail: file.relative,
      icon: "fileCode",
      run: () => openFile(file.relative),
    }));

    const actionRows: Row[] = listedCommands().map((command) => ({
      key: `action:${command.id}`,
      group: "Actions",
      label: command.label,
      icon: "sparkles",
      keys: command.keys,
      run: () => onCommand(command.id),
    }));

    switch (effective) {
      case "agents":
        return sessionRows((kind) => kind === "agent");
      case "sessions":
        return sessionRows(() => true);
      case "files":
        return fileRows;
      case "actions":
        return actionRows;
      case "all":
      default:
        return [...sessionRows(() => true), ...fileRows, ...actionRows];
    }
  }, [effective, wsSessions, statusOf, openSession, openFile, onCommand, files]);

  const results = useMemo(() => {
    if (!needle) {
      if (effective !== "all") return rows.slice(0, 40);
      const recent = wsSessions
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5)
        .map((session) => rows.find((row) => row.key === `session:${session.id}`))
        .filter((row): row is Row => Boolean(row));
      const actions = rows.filter((row) => row.group === "Actions").slice(0, 5);
      return [...recent, ...actions];
    }
    return rankBy(rows, needle, (row) => `${row.label} ${row.detail ?? ""}`).slice(0, 60);
  }, [needle, rows, effective, wsSessions]);

  const grouped = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of results) {
      const held = map.get(row.group);
      if (held) held.push(row);
      else map.set(row.group, [row]);
    }
    return [...map];
  }, [results]);

  useEffect(() => setCursor(0), [needle, effective]);

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (row: Row | undefined) => {
    if (!row) return;
    setPalette(null);
    row.run();
  };

  const cycleFilter = (delta: number) => {
    const index = FILTERS.findIndex((entry) => entry.id === filter);
    const next = (((index + delta) % FILTERS.length) + FILTERS.length) % FILTERS.length;
    setPalette(FILTERS[next]!.id);
  };

  let flatIndex = -1;

  return (
    <Modal open={open} onOpenChange={(next) => !next && setPalette(null)} width={640} label="Command palette" className="top-[12%] overflow-hidden">
      <div
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setCursor((held) => Math.min(results.length - 1, held + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setCursor((held) => Math.max(0, held - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(results[cursor]);
          } else if (event.key === "Tab") {
            event.preventDefault();
            cycleFilter(event.shiftKey ? -1 : 1);
          }
        }}
      >
        <div className="flex items-center gap-2.5 px-4 pb-1 pt-3.5">
          <Icon name="search" size={17} className="shrink-0 text-ink-38" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents, files and actions…"
            className="h-8 min-w-0 flex-1 bg-transparent text-md outline-none placeholder:text-ink-38"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div className="flex items-center gap-1 border-b border-[var(--line-soft)] px-3.5 pb-2.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setPalette(entry.id)}
              className={cx(
                "rise-1 h-6 rounded-chip px-2 text-sm font-medium",
                entry.id === effective ? "bg-accent-soft text-accent-text" : "text-ink-52 hover:text-ink",
              )}
            >
              {entry.label}
            </button>
          ))}
          <span className="flex-1" />
          <span className="text-xs text-ink-38">{results.length} results</span>
        </div>

        <div ref={listRef} className="scroller max-h-[52vh] min-h-[180px] p-1.5">
          {results.length === 0 && (
            <p className="px-3 py-10 text-center text-base text-ink-38">Nothing matches “{needle}”.</p>
          )}
          {grouped.map(([group, items]) => (
            <div key={group} className="mb-1">
              <div className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">
                {group}
              </div>
              {items.map((row) => {
                flatIndex += 1;
                const index = flatIndex;
                const active = index === cursor;
                return (
                  <button
                    key={row.key}
                    type="button"
                    data-cursor={active}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => pick(row)}
                    className={cx(
                      "flex h-10 w-full items-center gap-2.5 rounded-control px-2.5 text-left",
                      active ? "bg-accent-soft el-1" : "",
                    )}
                  >
                    {row.seed ? (
                      <Avatar seed={row.seed} size={22} />
                    ) : (
                      <span className="grid size-[22px] shrink-0 place-items-center rounded-chip bg-sunken text-ink-52">
                        <Icon name={row.icon ?? "hash"} size={14} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-ink">{row.label}</span>
                    </span>
                    {row.detail && <span className="max-w-[46%] shrink-0 truncate text-sm text-ink-38">{row.detail}</span>}
                    {row.keys ? <Kbd>{row.keys}</Kbd> : row.status ? <StatusDot status={row.status} /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--line-soft)] bg-sunken px-4 py-2 text-xs text-ink-38">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Select
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⏎</Kbd> Open
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>⇥</Kbd> Change filter
          </span>
          <span className="flex-1" />
          <span className="flex items-center gap-1.5">
            <Kbd>&gt;</Kbd> Actions
          </span>
        </div>
      </div>
    </Modal>
  );
}
