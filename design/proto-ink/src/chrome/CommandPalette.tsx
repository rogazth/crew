import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMANDS,
  commandKeys,
  elapsed,
  fuzzyMatch,
  highlightRuns,
  diffs,
  listedCommands,
  providerLine,
} from "@crew/fixtures";
import type { CommandId, SessionStatus } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";
import { fileIcon } from "@/lib/files";
import { runCommand } from "@/lib/commands";
import { useApp, type PaletteFilter } from "@/lib/store";
import { Avatar, DialogPrimitive, StatusDot } from "@/ui";

const FILTERS: Array<{ id: PaletteFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "files", label: "Files" },
  { id: "actions", label: "Actions" },
];

type Row = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon?: IconName;
  seed?: string;
  status?: SessionStatus;
  keys?: string;
  run: () => void;
};

export function CommandPalette() {
  const { palette, sessions, activeWorkspaceId, actions, terminal, files } = useApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PaletteFilter>("all");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!palette.open) return;
    setFilter(palette.filter);
    setQuery(palette.seed);
    setCursor(0);
  }, [palette.open, palette.filter, palette.seed]);

  // A leading ">" is the Actions filter written out longhand.
  const effectiveFilter: PaletteFilter = query.startsWith(">") ? "actions" : filter;
  // Ranking twenty thousand paths is a frame's work; the field must never wait
  // for it, so the results lag the caret rather than the other way round.
  const typed = query.startsWith(">") ? query.slice(1).trim() : query.trim();
  const needle = useDeferredValue(typed);

  const rows = useMemo<Row[]>(() => {
    const close = actions.closePalette;
    const workspaceSessions = sessions.filter((s) => s.workspaceId === activeWorkspaceId);

    const sessionRows = (kinds: Array<"agent" | "terminal">): Row[] =>
      workspaceSessions
        .filter((session) => kinds.includes(session.kind))
        .map((session) => ({
          id: `session:${session.id}`,
          group: session.kind === "agent" ? "Agents" : "Terminals",
          label: session.name,
          detail:
            session.kind === "agent"
              ? providerLine(session.provider, session.model)
              : `updated ${elapsed(session.updatedAt)}`,
          seed: session.name,
          status: session.status,
          run: () => {
            close();
            actions.openSession(session.id);
          },
        }));

    // A file the fixtures have a patch for opens with a Changes tab; saying so
    // here is the only place the standalone diff surface advertises itself.
    const patched = new Map(diffs.map((entry) => [entry.path, entry]));
    const fileRows = (): Row[] =>
      files.map((file) => {
        const patch = patched.get(file.relative);
        return {
          id: `file:${file.relative}`,
          group: "Files",
          label: file.relative,
          icon: fileIcon(file.relative),
          ...(patch ? { detail: `+${patch.added} −${patch.removed} uncommitted` } : {}),
          run: () => {
            close();
            actions.openFile(file.relative, file.path);
          },
        };
      });

    const actionRows = (): Row[] => {
      const base: Row[] = listedCommands().map((command) => ({
        id: `action:${command.id}`,
        group: COMMANDS[command.id as CommandId].group,
        label: command.label,
        icon: "command" as IconName,
        keys: command.keys,
        run: () => {
          close();
          runCommand(command.id as CommandId, actions, terminal.fontSize);
        },
      }));
      const extras: Row[] = [
        ["Appearance settings", "palette", () => actions.openSettings("appearance")],
        ["Keybindings", "keyboard", () => actions.openSettings("keybindings")],
        ["Terminal settings", "terminal", () => actions.openSettings("terminal")],
        ["Providers", "package", () => actions.openSettings("providers")],
        ["About Crew", "info", () => actions.openSettings("about")],
      ].map(([label, icon, run]) => ({
        id: `action:extra:${label as string}`,
        group: "View",
        label: label as string,
        icon: icon as IconName,
        run: () => {
          close();
          (run as () => void)();
        },
      }));
      return [...base, ...extras];
    };

    switch (effectiveFilter) {
      case "agents":
        return sessionRows(["agent"]);
      case "sessions":
        return sessionRows(["agent", "terminal"]);
      case "files":
        return fileRows();
      case "actions":
        return actionRows();
      case "all":
        return [...sessionRows(["agent", "terminal"]), ...fileRows(), ...actionRows()];
    }
  }, [effectiveFilter, sessions, activeWorkspaceId, actions, terminal.fontSize, files]);

  const results = useMemo(() => {
    if (!needle) {
      if (effectiveFilter !== "all") return rows.slice(0, 40);
      // Empty "All" is a launchpad, not a dump: five recent sessions, five actions.
      const recent = [...rows.filter((r) => r.id.startsWith("session:"))].slice(0, 5);
      const acts = rows.filter((r) => r.id.startsWith("action:")).slice(0, 5);
      return [...recent, ...acts];
    }
    const scored: Array<{ row: Row; score: number; positions: number[] }> = [];
    for (const row of rows) {
      const hit = fuzzyMatch(needle, row.label);
      if (!hit) continue;
      scored.push({ row, score: hit.score, positions: hit.positions });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((entry) => ({ ...entry.row, positions: entry.positions }));
  }, [rows, needle, effectiveFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, Array<Row & { positions?: number[] }>>();
    for (const row of results) {
      const held = map.get(row.group);
      if (held) held.push(row);
      else map.set(row.group, [row]);
    }
    return [...map];
  }, [results]);

  const flat = grouped.flatMap(([, items]) => items);
  const active = flat[Math.min(cursor, flat.length - 1)];

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-cursor="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  const cycleFilter = (delta: number) => {
    const index = FILTERS.findIndex((f) => f.id === effectiveFilter);
    const next = (((index + delta) % FILTERS.length) + FILTERS.length) % FILTERS.length;
    setFilter(FILTERS[next]!.id);
    if (query.startsWith(">")) setQuery(query.slice(1));
    setCursor(0);
  };

  return (
    <DialogPrimitive.Root
      open={palette.open}
      onOpenChange={(next: boolean) => !next && actions.closePalette()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="ink-backdrop fixed inset-0 z-[80]" />
        <DialogPrimitive.Popup
          className={cx(
            "ink-pop e3 fixed left-1/2 top-[14vh] z-[81] flex w-[min(640px,92vw)] -translate-x-1/2",
            "flex-col overflow-hidden rounded-card bg-canvas outline-none",
          )}
        >
          <div className="flex h-11 shrink-0 items-center gap-2 px-3">
            <Icon name="search" size={16} className="shrink-0 text-icon-faint" />
            <input
              autoFocus
              value={query}
              placeholder={
                effectiveFilter === "files"
                  ? "Go to file…"
                  : effectiveFilter === "actions"
                    ? "Run an action…"
                    : "Search sessions, files and actions…"
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setCursor((c) => Math.min(c + 1, flat.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (event.key === "Tab") {
                  event.preventDefault();
                  cycleFilter(event.shiftKey ? -1 : 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  active?.run();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  actions.closePalette();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-prose text-primary outline-none placeholder:text-quaternary"
            />
          </div>

          <div className="flex shrink-0 items-center gap-1 border-t border-[var(--stroke-tertiary)] px-2 py-1.5">
            {FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setFilter(option.id);
                  if (query.startsWith(">")) setQuery(query.slice(1));
                  setCursor(0);
                }}
                className={cx(
                  "h-5 rounded-sm px-2 text-micro transition-colors duration-[var(--dur-1)]",
                  option.id === effectiveFilter
                    ? "bg-[var(--fill-secondary)] text-primary"
                    : "text-tertiary hover:bg-[var(--fill-tertiary)] hover:text-secondary",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div
            ref={listRef}
            className="ink-scroll max-h-[min(50vh,420px)] min-h-24 overflow-y-auto border-t border-[var(--stroke-tertiary)] p-1"
          >
            {flat.length === 0 && (
              <p className="px-3 py-8 text-center text-small text-quaternary">
                Nothing matches “{needle}”.
              </p>
            )}
            {grouped.map(([group, items]) => (
              <div key={group} className="mb-1">
                <p className="px-2 pb-1 pt-1.5 text-micro font-[var(--weight-medium)] uppercase tracking-[0.06em] text-quaternary">
                  {group}
                </p>
                {items.map((row) => {
                  const index = flat.indexOf(row);
                  const isCursor = index === Math.min(cursor, flat.length - 1);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      data-cursor={isCursor}
                      onMouseMove={() => setCursor(index)}
                      onClick={row.run}
                      className={cx(
                        "relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left",
                        "transition-colors duration-[var(--dur-1)]",
                        isCursor ? "bg-[var(--fill-tertiary)]" : "hover:bg-[var(--fill-quaternary)]",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)]",
                          isCursor ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {row.seed ? (
                          <Avatar seed={row.seed} size={16} />
                        ) : (
                          <Icon name={row.icon ?? "command"} size={14} className="text-icon-faint" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body text-primary">
                        {row.positions
                          ? highlightRuns(row.label, row.positions).map((run, i) =>
                              run.hit ? (
                                <em
                                  key={i}
                                  className="not-italic text-[var(--accent)] [font-variation-settings:'wght'_560]"
                                >
                                  {run.text}
                                </em>
                              ) : (
                                <span key={i}>{run.text}</span>
                              ),
                            )
                          : row.label}
                      </span>
                      {row.detail && (
                        <span className="max-w-48 shrink-0 truncate text-micro text-quaternary">
                          {row.detail}
                        </span>
                      )}
                      {row.keys && (
                        <kbd className="shrink-0 rounded-sm bg-[var(--fill-tertiary)] px-1 font-sans text-micro leading-[15px] text-tertiary">
                          {row.keys}
                        </kbd>
                      )}
                      {row.status && <StatusDot status={row.status} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--stroke-tertiary)] px-3 text-micro text-quaternary">
            <Hint keys="↑↓" label="Select" />
            <Hint keys="⏎" label="Open" />
            <Hint keys="⇥" label="Change filter" />
            <span className="ml-auto">{commandKeys("open-palette")}</span>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded-xs bg-[var(--fill-tertiary)] px-1 font-sans leading-[15px] text-tertiary">
        {keys}
      </kbd>
      {label}
    </span>
  );
}
