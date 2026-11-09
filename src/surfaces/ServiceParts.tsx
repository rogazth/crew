// The pieces the Services list and a service's page share: Start, which asks
// for the worktree with New session's list; a run as a pill (where, how long,
// and a ⋯ with the rest); and who wrote a service.
import { Popover } from "@base-ui/react/popover";
import { BotIcon, EllipsisIcon, GitBranchIcon, PlayIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BotAvatar } from "../chrome/BotAvatar";
import { ListNote, PopupSearch, ROW } from "../chrome/kit";
import { ProcessDot } from "../chrome/ProcessDot";
import { pickerKeyDown } from "../chrome/promptKeys";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { fuzzyMatch } from "../lib/fuzzy";
import type { MenuPoint } from "../lib/menu";
import {
  formatEnv,
  isLive,
  isOrphan,
  rerunEnv,
  runIn,
  stateLabel,
  withPending,
  type Origin,
  type Place,
  type Process,
  type ProcessRun,
} from "../lib/processes";
import { elapsed } from "../lib/time";
import type { Session } from "../lib/types";

export type { Place } from "../lib/processes";

/** Starts `process` in `worktree`, the run showing as starting from the press on. */
export type Start = (process: Process, worktree: string | null, env: Record<string, string> | undefined) => void;
/** Stops `process` in `worktree`. */
export type Stop = (process: Process, worktree: string | null) => void;

type KeyDown = KeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void };

const TRIGGER =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium outline-none transition-colors hover:bg-hover focus-visible:bg-hover data-popup-open:bg-hover";

/**
 * Start. With one worktree it starts there at once, and turns into Stop while
 * it runs. With more it asks where, with the list New session opens for its
 * worktree: a search, then the worktrees it does not run in yet. It never
 * turns into Stop there: which run would it stop? Each run's ⋯ stops it.
 * ↑/↓ move, Enter runs, Esc clears the search and then closes.
 */
export function RunIn({
  process,
  places: all,
  pending,
  onStart,
  onStop,
}: {
  process: Process;
  places: Place[];
  /** Runs asked for and not yet answered: already taken. */
  pending: ReadonlySet<string>;
  onStart: Start;
  onStop: Stop;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const runs = withPending(process, pending);
  const up = (place: Place) => isLive(runs.find((run) => run.worktree === place.worktree));
  const places = all.filter((place) => !up(place));

  const needle = query.trim();
  const rows = needle
    ? places
        .map((item, at) => ({ item, at, hit: fuzzyMatch(needle, item.label) }))
        .filter((row) => row.hit !== null)
        .sort((a, b) => b.hit!.score - a.hit!.score || a.at - b.at)
        .map((row) => row.item)
    : places;
  const active = rows.length === 0 ? -1 : Math.min(cursor, rows.length - 1);

  useEffect(() => {
    if (!open || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, needle]);

  const pick = (place: Place) => {
    setOpen(false);
    onStart(process, place.worktree, rerunEnv(process, runIn(process, place.worktree)));
  };
  const onKeyDown = (event: KeyDown) => {
    if (pickerKeyDown(event, "W", () => setOpen(false))) return;
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      event.preventBaseUIHandler?.();
      setQuery("");
      setCursor(0);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(Math.max(0, Math.min(rows.length - 1, (active < 0 ? 0 : active) + (event.key === "ArrowDown" ? 1 : -1))));
      return;
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    }
  };

  const only = all.length === 1 ? all[0] : undefined;
  if (only) {
    const running = up(only);
    const Icon = running ? SquareIcon : PlayIcon;
    return (
      <button
        type="button"
        aria-label={`${running ? "Stop" : "Start"} ${process.name}`}
        onClick={() => (running ? onStop(process, only.worktree) : pick(only))}
        className={TRIGGER}
      >
        <Icon className="size-3.5 text-icon" />
        {running ? "Stop" : "Start"}
      </button>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery("");
          setCursor(0);
        }
        setOpen(next);
      }}
      modal={false}
    >
      <Popover.Trigger
        aria-label={`Start ${process.name} in…`}
        className={TRIGGER}
      >
        <PlayIcon className="size-3.5 text-icon" />
        Start
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup
            initialFocus={search}
            onKeyDown={onKeyDown}
            className="flex max-h-[min(360px,70vh)] w-72 origin-(--transform-origin) flex-col overflow-hidden rounded-xl bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            {/* No rule under the search: the list follows it straight on. */}
            <div className="[&>div]:border-b-0">
              <PopupSearch
                ref={search}
                value={query}
                placeholder={`Start ${process.name} in…`}
                aria-label="Search worktrees"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
                onClear={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              />
            </div>
            <div ref={list} role="listbox" aria-label="Worktrees" className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
              {rows.length === 0 ? (
                <ListNote>{needle ? "No matches" : "Running in every worktree"}</ListNote>
              ) : (
                rows.map((item, index) => (
                  <div
                    key={item.worktree ?? ""}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    data-highlighted={index === active ? "" : undefined}
                    onMouseMove={() => index !== active && setCursor(index)}
                    onClick={() => pick(item)}
                    className={ROW}
                  >
                    <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-icon" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </div>
                ))
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * One run as a pill: where and how long it has been up, or that it failed.
 * Its ⋯ (or a right-click) holds the rest: the output, what it serves, Restart
 * and Stop, and Dismiss for one that failed. Start starts it again.
 */
export function RunPill({
  process,
  run,
  place,
  sessions,
  onMenu,
}: {
  process: Process;
  run: ProcessRun;
  place: Place;
  sessions: Session[];
  onMenu: (point: MenuPoint) => void;
}) {
  const live = isLive(run);
  const orphan = isOrphan(run, new Set(sessions.map((session) => session.id)));
  const starter =
    run.startedBy === null ? "you" : (sessions.find((session) => session.id === run.startedBy)?.name ?? "a session since closed");
  const failed = run.state === "crashed" || (run.state === "exited" && run.exitCode !== 0);
  const own = Object.fromEntries(Object.entries(run.env).filter(([key, value]) => process.env[key] !== value));
  const how = run.state === "running" && run.startedAt !== null ? elapsed(run.startedAt) : stateLabel(run);
  const title = [`${process.name} in ${place.label}`, run.startedAt !== null ? `Started by ${starter}` : null, formatEnv(own)]
    .filter(Boolean)
    .join("\n");
  return (
    <span
      data-run
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      className={`inline-flex h-8 max-w-64 min-w-0 items-center gap-2 rounded-full bg-card pr-1 pl-3 text-[12.5px] ${live ? "" : "text-text-muted"}`}
    >
      {failed ? <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-danger" /> : <ProcessDot run={run} />}
      <span title={title} className="flex min-w-0 items-center gap-2">
        <span className={`truncate ${live ? "font-medium" : ""}`}>{place.label}</span>
        {orphan ? (
          <span data-orphan className="shrink-0 text-warning">
            Left running
          </span>
        ) : (
          <span className={`shrink-0 ${failed ? "text-danger" : "text-text-muted"}`}>{how}</span>
        )}
      </span>
      <button
        type="button"
        aria-label={`More for ${process.name} in ${place.label}`}
        title="More"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
        className="grid size-6 shrink-0 place-items-center rounded-full text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
      >
        <EllipsisIcon className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * How a run stands, with no pill around it (a workspace of one worktree): its
 * dot and how long it has been up, or that it failed or was left running.
 */
export function RunStatus({ run, sessions }: { run: ProcessRun; sessions: Session[] }) {
  const failed = run.state === "crashed" || (run.state === "exited" && run.exitCode !== 0);
  const orphan = isOrphan(run, new Set(sessions.map((session) => session.id)));
  const how = run.state === "running" && run.startedAt !== null ? elapsed(run.startedAt) : stateLabel(run);
  return (
    <span data-run className="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-normal">
      {failed ? <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-danger" /> : <ProcessDot run={run} />}
      {orphan ? (
        <span data-orphan className="text-warning">
          Left running
        </span>
      ) : (
        <span className={failed ? "text-danger" : "text-text-muted"}>{how}</span>
      )}
    </span>
  );
}

/** Which session wrote a service, as a face and a name; nothing for one the user wrote. */
export function OriginTag({ origin }: { origin: Origin }) {
  if (origin.kind === "user") return null;
  const { session } = origin;
  const name = session?.name ?? "a session since closed";
  return (
    <span
      data-origin="session"
      title={`Created by ${name}`}
      className="inline-flex max-w-44 shrink-0 items-center gap-1 align-middle text-[12px] font-normal text-text-muted"
    >
      {session?.kind === "bot" ? (
        <BotAvatar seed={session.id} bare className="size-3.5 shrink-0" />
      ) : session ? (
        <ProviderIcon provider={session.provider} className="size-3.5" />
      ) : (
        <BotIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
