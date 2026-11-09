import { EllipsisIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ActionMenu } from "../chrome/ActionMenu";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Button, EmptyState, FilterChip, FilterTabs, IconButton, PageFrame, SearchField } from "../chrome/kit";
import { deleteConfirm, type Processes } from "../hooks/useProcesses";
import type { MenuPoint } from "../lib/menu";
import {
  isLive,
  liveRuns,
  localUrl,
  placeOf,
  processActions,
  runIn,
  runActions,
  runKey,
  runSeen,
  shownRuns,
  type Place,
  type Process,
  type ProcessRun,
} from "../lib/processes";
import { showToast } from "../lib/toasts";
import type { Session } from "../lib/types";
import { ServiceEditor } from "./ServiceEditor";
import { RunIn, RunPill, RunStatus, type Start, type Stop } from "./ServiceParts";
import { EmptyServices } from "./EmptyServices";
import { ProcessTab } from "./ProcessTab";
export type { Place } from "../lib/processes";

/** What covers the list: a new service, one's page, or one run's output, a level under it. */
export type ServiceOpen = { kind: "new" } | { kind: "edit"; id: string } | { kind: "output"; id: string; worktree: string | null };

type Props = {
  workspaceId: string;
  processes: Processes;
  /** The workspace's worktrees, the main checkout first. */
  places: Place[];
  /** Every session, to name who wrote or started something, and to tell one that is gone. */
  sessions: Session[];
  /** Opens a run's address in a Crew browser tab. */
  onOpenBrowser: (url: string) => void;
  onConfirm: (confirm: Confirm) => void;
  /** What covers the list, kept by the page so the shell knows which service is on screen; null: the list. */
  open: ServiceOpen | null;
  onOpen: (open: ServiceOpen | null) => void;
};

type Filter = "all" | "running" | "stopped";
type By = "anyone" | "you" | "agents";

/** Past this many, a search sits over the list. */
const SEARCH_FROM = 7;

/**
 * The workspace's services: defined once, run in any of its worktrees. Each
 * lists where it runs and who started it there, so a dev server an agent left
 * behind is in plain sight, with its × beside it; one an agent wrote says so.
 * Start asks where, with New session's list; a service opens as a page.
 */
export function ServicesView({ workspaceId, processes, places, sessions, onOpenBrowser, onConfirm, open, onOpen: setOpen }: Props) {
  /** A service's ⋯, or with `run` one run's right-click. */
  const [menu, setMenu] = useState<{ point: MenuPoint; process: Process; run?: ProcessRun } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [by, setBy] = useState<By>("anyone");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Pills taken away, by the start of the run they stood for. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const dismiss = useCallback((process: Process, run: ProcessRun) => setDismissed((prev) => new Set(prev).add(runSeen(process.id, run))), []);
  const list = processes.processes;

  const { run } = processes;
  const start: Start = useCallback(
    (process, worktree, env) => {
      const key = runKey(process.id, worktree);
      setPending((prev) => new Set(prev).add(key));
      void run("start", process, worktree, env).finally(() =>
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        }),
      );
    },
    [run],
  );
  const stop: Stop = useCallback((process, worktree) => void run("stop", process, worktree), [run]);

  const remove = (process: Process) => {
    const confirm = deleteConfirm(process);
    onConfirm({
      ...confirm,
      onConfirm: async () => {
        await confirm.onConfirm();
        setOpen(null);
      },
    });
  };

  /** One worktree: no pills, so the service's own ⋯ holds its run's actions. */
  const solo = places.length === 1 ? places[0] : undefined;
  const soloRun = (process: Process) => (solo ? runIn(process, solo.worktree) : undefined);

  const pick = (id: string, process: Process, run?: ProcessRun) => {
    if (run) {
      const url = localUrl(run);
      if (id === "output") return setOpen({ kind: "output", id: process.id, worktree: run.worktree });
      if (id === "browser" && url) return onOpenBrowser(url);
      if (id === "dismiss") return dismiss(process, run);
      if (id === "restart" || id === "stop") return void processes.run(id, process, run.worktree);
    }
    if (id === "edit") setOpen({ kind: "edit", id: process.id });
    else if (id === "delete") remove(process);
  };

  const all = useMemo(() => list ?? [], [list]);
  const agents = all.filter((process) => process.createdBy !== null).length;
  // A filter whose control has gone (the last agent's service deleted, the list under the search's size) no longer
  // narrows: nothing on screen could undo it.
  const byShown = agents > 0 && agents < all.length;
  const searchShown = all.length >= SEARCH_FROM;
  const author = byShown ? by : "anyone";
  const text = searchShown ? query.trim().toLowerCase() : "";
  const narrowed = useMemo(
    () =>
      all.filter(
        (process) =>
          (author === "anyone" || (author === "you") === (process.createdBy === null)) &&
          (text === "" || [process.name, process.command].some((field) => field.toLowerCase().includes(text))),
      ),
    [all, author, text],
  );
  const up = (process: Process) => process.runs.some(isLive);
  const shown = narrowed.filter((process) => (filter === "all" ? true : filter === "running" ? up(process) : !up(process)));
  const running = narrowed.filter(up).length;
  const live = liveRuns(all).length;

  if (open?.kind === "output") {
    const { id, worktree } = open;
    return (
      <ProcessTab
        key={`${id}:${worktree ?? ""}`}
        processId={id}
        worktree={worktree}
        place={places.length > 1 ? placeOf(places, worktree).label : null}
        processes={processes}
        onBack={() => setOpen(null)}
      />
    );
  }
  if (open) {
    const found = open.kind === "edit" ? list?.find((process) => process.id === open.id) : undefined;
    if (open.kind === "new" || found) {
      return (
        <ServiceEditor
          key={found?.id ?? "new"}
          workspaceId={workspaceId}
          process={found}
          sessions={sessions}
          onBack={() => setOpen(null)}
          onCreated={(created) => {
            // Back to the list, where the new service now stands.
            setOpen(null);
            showToast({ title: "Service created", body: created.name, source: "done", target: null, duration: 4000 });
          }}
          onDelete={() => found && remove(found)}
        />
      );
    }
  }

  return (
    <PageFrame
      title="Services"
      subtitle="Dev servers and watchers, run in any worktree."
      actions={
        // With none yet, the empty state's own button is the way in: one, not two.
        all.length > 0 && (
          <Button variant="primary" icon={PlusIcon} onClick={() => setOpen({ kind: "new" })}>
            New service
          </Button>
        )
      }
    >
      {processes.error && (
        <p role="alert" className="-my-3 px-1 text-[12px] text-danger">
          {processes.error}
        </p>
      )}

      {list !== null && list.length === 0 ? (
        <EmptyServices onNew={() => setOpen({ kind: "new" })} />
      ) : (
        list !== null && (
          <div className="flex flex-col gap-3">
            {searchShown && <SearchField value={query} label="Search services" onChange={setQuery} />}
            <div className="flex items-center gap-2">
              <FilterTabs
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All", count: narrowed.length },
                  { value: "running", label: "Running", count: running },
                  { value: "stopped", label: "Stopped", count: narrowed.length - running },
                ]}
              />
              <span className="flex-1" />
              {byShown && (
                <FilterChip
                  label="Added by"
                  // From its right edge, as the Routines filters; three names need no search.
                  align="end"
                  value={by}
                  neutral="anyone"
                  options={[
                    { value: "anyone", label: "Anyone" },
                    { value: "you", label: "You" },
                    { value: "agents", label: "Agents" },
                  ]}
                  onChange={setBy}
                />
              )}
              {/* Stop all only once there is more than one run to stop: one run stops from its own pill. */}
              {live > 1 && (
                <Button variant="ghost" size="sm" icon={SquareIcon} title={`Stop all ${live} runs`} onClick={() => void processes.stopAll()}>
                  Stop all
                </Button>
              )}
            </div>

            {shown.length === 0 ? (
              <EmptyState title="No results." />
            ) : (
              <div className="flex flex-col border-t border-hairline">
                {shown.map((process) => (
                  <CommandRow
                    key={process.id}
                    process={process}
                    places={places}
                    sessions={sessions}
                    pending={pending}
                    dismissed={dismissed}
                    onStart={start}
                    onStop={stop}
                    onOpen={() => setOpen({ kind: "edit", id: process.id })}
                    onMenu={(point, run) => setMenu({ point, process, ...(run && { run }) })}
                  />
                ))}
              </div>
            )}
          </div>
        )
      )}

      {menu && (
        <ActionMenu
          compact
          key={`${menu.process.id}:${menu.run?.worktree ?? ""}`}
          point={menu.point}
          actions={
            menu.run
              ? runActions(menu.run)
              : processActions(soloRun(menu.process))
          }
          onPick={(id) => {
            const { process, run: ran } = menu;
            setMenu(null);
            pick(id, process, ran ?? soloRun(process));
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </PageFrame>
  );
}

/**
 * One service on the sheet, a hairline under it: its name, what it runs, Start
 * and its ⋯; under them, a pill for each worktree it runs in. With one
 * worktree there are no pills: how its run stands sits by the name. A press on
 * the name opens its page.
 */
function CommandRow({
  process,
  places,
  sessions,
  pending,
  dismissed,
  onStart,
  onStop,
  onOpen,
  onMenu,
}: {
  process: Process;
  places: Place[];
  sessions: Session[];
  pending: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  onStart: Start;
  onStop: Stop;
  onOpen: () => void;
  onMenu: (point: MenuPoint, run?: ProcessRun) => void;
}) {
  const runs = shownRuns(process, pending, dismissed);
  const solo = places.length === 1;
  return (
    <section
      aria-label={process.name}
      data-command
      className="flex flex-col gap-2.5 border-b border-hairline px-1 py-3.5"
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2.5">
            {/* Only the name opens it: as wide as its text, not the row. */}
            <button
              type="button"
              aria-label={`Open ${process.name}`}
              onClick={onOpen}
              className="min-w-0 truncate rounded-sm text-left text-[13px] leading-[18px] font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              {process.name}
            </button>
            {solo && runs[0] && <RunStatus run={runs[0]} sessions={sessions} />}
          </span>
          <span className="truncate font-mono text-[12px] leading-4 text-text-muted" title={process.command}>
            {process.cwd ? `${process.cwd} $ ` : "$ "}
            {process.command}
          </span>
        </div>
        <RunIn process={process} places={places} pending={pending} onStart={onStart} onStop={onStop} />
        <IconButton
          icon={EllipsisIcon}
          className="size-7"
          label={`More for ${process.name}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.right, y: rect.bottom + 4, align: "end" });
          }}
        />
      </div>
      {!solo && runs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {runs.map((run) => (
            <RunPill
              key={run.worktree ?? ""}
              process={process}
              run={run}
              place={placeOf(places, run.worktree)}
              sessions={sessions}
              onMenu={(point) => onMenu(point, run)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
