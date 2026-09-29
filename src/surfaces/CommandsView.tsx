import { EllipsisIcon, PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";
import { useState, type MouseEvent } from "react";
import { ActionMenu } from "../chrome/ActionMenu";
import { BranchDot } from "../chrome/BranchDot";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Button, Field, Footer, IconButton, Overlay, PageFrame, Select, TextArea } from "../chrome/kit";
import { ProcessDialog } from "../chrome/ProcessDialog";
import { ProcessDot } from "../chrome/ProcessDot";
import { deleteConfirm, type Processes } from "../hooks/useProcesses";
import type { MenuPoint } from "../lib/menu";
import {
  awaitsUser,
  formatEnv,
  isLive,
  isOrphan,
  parseEnv,
  processActions,
  specChanges,
  specOf,
  stateLabel,
  type Process,
  type ProcessRun,
} from "../lib/processes";
import { elapsed } from "../lib/time";
import type { Session } from "../lib/types";

/** A worktree a command can run in: `worktree` null is the main checkout. */
export type Place = { worktree: string | null; label: string; hue: number };

type Props = {
  workspaceId: string;
  processes: Processes;
  /** The workspace's worktrees, the main checkout first. */
  places: Place[];
  /** Every session, to name who wrote or started something, and to tell one that is gone. */
  sessions: Session[];
  onOpenRun: (process: Process, worktree: string | null) => void;
  onConfirm: (confirm: Confirm) => void;
};

/**
 * The workspace's commands: defined once, run in any of its worktrees. Each
 * command lists where it runs and who started it there, so a dev server an
 * agent left behind is in plain sight, with its Stop beside it.
 */
export function CommandsView({ workspaceId, processes, places, sessions, onOpenRun, onConfirm }: Props) {
  const [editing, setEditing] = useState<{ process?: Process } | null>(null);
  const [starting, setStarting] = useState<Process | null>(null);
  const [menu, setMenu] = useState<{ point: MenuPoint; process: Process } | null>(null);
  const list = processes.processes;
  const asking = list?.filter(awaitsUser) ?? [];

  const pick = (id: string, process: Process) => {
    if (id === "edit") setEditing({ process });
    else if (id === "delete") onConfirm(deleteConfirm(process));
    else if (id === "copy-command") void navigator.clipboard.writeText(process.command);
    else if (id === "approve" || id === "reject") void processes.decide(id, process);
  };

  return (
    <PageFrame
      title="Commands"
      subtitle="Dev servers, watchers and workers, defined once for the workspace and run in any of its worktrees."
      actions={
        <Button variant="primary" icon={PlusIcon} onClick={() => setEditing({})}>
          New command
        </Button>
      }
    >
      {processes.error && (
        <p role="alert" className="text-[12px] text-danger">
          {processes.error}
        </p>
      )}

      {asking.map((process) => (
        <ApprovalCard key={process.id} process={process} sessions={sessions} processes={processes} />
      ))}

      {list !== null && list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-text-muted">
          No commands yet. Add the ones you start by hand, like <code className="font-mono text-[12px]">npm run dev</code>,
          and run them in any worktree. Agents use them too.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {list?.map((process) => (
            <CommandBlock
              key={process.id}
              process={process}
              places={places}
              sessions={sessions}
              processes={processes}
              onRunIn={() => setStarting(process)}
              onOpenRun={(worktree) => onOpenRun(process, worktree)}
              onMenu={(point) => setMenu({ point, process })}
            />
          ))}
        </div>
      )}

      {menu && (
        <ActionMenu
          key={menu.process.id}
          point={menu.point}
          title={menu.process.name}
          actions={processActions(menu.process)}
          onPick={(id) => {
            const process = menu.process;
            setMenu(null);
            pick(id, process);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {editing && (
        <ProcessDialog
          workspaceId={workspaceId}
          process={editing.process}
          onClose={() => setEditing(null)}
        />
      )}
      {starting && (
        <RunDialog
          process={starting}
          places={places}
          onClose={() => setStarting(null)}
          onRun={async (worktree, env) => {
            await processes.run("start", starting, worktree, env);
            setStarting(null);
          }}
        />
      )}
    </PageFrame>
  );
}

function CommandBlock({
  process,
  places,
  sessions,
  processes,
  onRunIn,
  onOpenRun,
  onMenu,
}: {
  process: Process;
  places: Place[];
  sessions: Session[];
  processes: Processes;
  onRunIn: () => void;
  onOpenRun: (worktree: string | null) => void;
  onMenu: (point: MenuPoint) => void;
}) {
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  return (
    <section
      aria-label={process.name}
      className="flex flex-col rounded-xl ring-1 ring-border"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <header className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{process.name}</span>
          <span className="truncate font-mono text-[12px] text-text-muted" title={process.command}>
            {process.cwd ? `${process.cwd} $ ` : "$ "}
            {process.command}
          </span>
        </div>
        {Object.keys(process.env).length > 0 && (
          <span className="hidden max-w-60 shrink-0 truncate font-mono text-[11px] text-text-muted sm:inline" title={formatEnv(process.env)}>
            {formatEnv(process.env).replaceAll("\n", " ")}
          </span>
        )}
        {process.approved && (
          <Button icon={PlayIcon} className="text-[12px]" onClick={onRunIn}>
            Run in…
          </Button>
        )}
        <IconButton icon={EllipsisIcon} label={`More for ${process.name}`} onClick={openMenu} />
      </header>
      {process.runs.length > 0 && (
        <ul className="flex flex-col border-t border-hairline py-1">
          {process.runs.map((run) => (
            <RunRow
              key={run.worktree ?? ""}
              process={process}
              run={run}
              place={placeOf(places, run.worktree)}
              sessions={sessions}
              processes={processes}
              onOpen={() => onOpenRun(run.worktree)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One worktree's run: where, how it stands, who started it, and what to do about it. */
function RunRow({
  process,
  run,
  place,
  sessions,
  processes,
  onOpen,
}: {
  process: Process;
  run: ProcessRun;
  place: Place;
  sessions: Session[];
  processes: Processes;
  onOpen: () => void;
}) {
  const live = isLive(run);
  const orphan = isOrphan(run, new Set(sessions.map((session) => session.id)));
  const starter =
    run.startedBy === null ? "you" : (sessions.find((session) => session.id === run.startedBy)?.name ?? "a session since closed");
  const own = Object.entries(run.env).filter(([key, value]) => process.env[key] !== value);
  // Started again from here, a run keeps the env it had: its own port stays its own.
  const act = (command: "start" | "stop" | "restart") =>
    void processes.run(command, process, run.worktree, command === "start" && own.length > 0 ? run.env : undefined);
  return (
    <li className="group/run flex h-9 items-center gap-2.5 px-3">
      <ProcessDot run={run} />
      <span className="min-w-0 max-w-48 shrink truncate" title={run.worktree ?? place.label}>
        {place.label}
      </span>
      <span className="shrink-0 text-[12px] text-text-muted">
        {stateLabel(run)}
        {live && run.startedAt !== null && run.state === "running" && ` · ${elapsed(run.startedAt)}`}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted">
        {orphan ? (
          <span className="rounded-full bg-warning/15 px-1.5 text-[11px] text-warning" title={`Started by ${starter}`}>
            Left running
          </span>
        ) : (
          `by ${starter}`
        )}
        {own.length > 0 && (
          <span className="ml-2 font-mono text-[11px]">{own.map(([key, value]) => `${key}=${value}`).join(" ")}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <IconButton icon={SquareTerminalIcon} label={`Logs of ${process.name} in ${place.label}`} title="Open logs" onClick={onOpen} />
        {(run.state === "running" || run.state === "paused") && (
          <IconButton icon={RotateCwIcon} label={`Restart ${process.name} in ${place.label}`} title="Restart" onClick={() => act("restart")} />
        )}
        {live ? (
          <IconButton icon={SquareIcon} label={`Stop ${process.name} in ${place.label}`} title="Stop" onClick={() => act("stop")} />
        ) : (
          process.approved && (
            <IconButton icon={PlayIcon} label={`Start ${process.name} in ${place.label}`} title="Start" onClick={() => act("start")} />
          )
        )}
      </span>
    </li>
  );
}

/** A worktree git no longer lists still has a name: the end of its path. */
function placeOf(places: Place[], worktree: string | null): Place {
  return (
    places.find((place) => place.worktree === worktree) ?? {
      worktree,
      label: worktree?.split("/").pop() ?? "main",
      hue: 0,
    }
  );
}

/** The main checkout in a select, whose values are strings: no path starts with a NUL. */
const KEY_MAIN = "\u0000main";

/** Where to start a command, and what of its env to change for that run. */
function RunDialog({
  process,
  places,
  onClose,
  onRun,
}: {
  process: Process;
  places: Place[];
  onClose: () => void;
  onRun: (worktree: string | null, env: Record<string, string> | undefined) => Promise<void>;
}) {
  const free = places.find((place) => !isLive(process.runs.find((run) => run.worktree === place.worktree)));
  const [where, setWhere] = useState(free?.worktree ?? places[0]?.worktree ?? null);
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const env = parseEnv(envText);
  const running = isLive(process.runs.find((run) => run.worktree === where));
  const options = places.map((place) => ({
    value: place.worktree ?? KEY_MAIN,
    label: place.label,
    icon: <BranchDot hue={place.hue} />,
  }));

  async function run() {
    if (busy || env.env === null || running) return;
    setBusy(true);
    try {
      await onRun(where, Object.keys(env.env).length > 0 ? env.env : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onClose} width="w-[440px]" label={`Run ${process.name}`}>
      <form
        className="flex flex-col gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          void run();
        }}
      >
        <div className="text-[14px] font-semibold">Run {process.name}</div>
        <Field label="Worktree" hint={running ? "It already runs there." : undefined}>
          <Select
            label="Worktree"
            className="w-full"
            value={where ?? KEY_MAIN}
            options={options}
            onChange={(value) => setWhere(value === KEY_MAIN ? null : value)}
          />
        </Field>
        <Field
          label="Environment for this run"
          hint={Object.keys(process.env).length > 0 ? `Over the command's: ${formatEnv(process.env).replaceAll("\n", ", ")}` : undefined}
          error={env.error}
        >
          <TextArea
            value={envText}
            placeholder={Object.keys(process.env).includes("PORT") ? "PORT=3001" : "NAME=value"}
            rows={2}
            className="min-h-0 font-mono text-[12px]"
            aria-invalid={env.error !== null}
            onChange={(event) => setEnvText(event.target.value)}
          />
        </Field>
        <button type="submit" hidden />
      </form>
      <Footer hints={[["⌘↵", "run"], ["esc", "cancel"]]}>
        <Button variant="ghost" className="text-[12px]" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          className="text-[12px]"
          loading={busy}
          disabled={env.env === null || running}
          onClick={() => void run()}
        >
          Run
        </Button>
      </Footer>
    </Overlay>
  );
}

/**
 * What an agent asked to run, for the user to read before it can. A new
 * command shows whole; a change shows only what it changes.
 */
function ApprovalCard({ process, sessions, processes }: { process: Process; sessions: Session[]; processes: Processes }) {
  const who = process.requestedBy ?? process.createdBy;
  const name = sessions.find((session) => session.id === who)?.name ?? "An agent";
  const changes = process.proposed ? specChanges(specOf(process), process.proposed) : [];
  return (
    <section
      aria-label={`${process.name} is waiting for your approval`}
      className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-warning/40"
    >
      <p>
        <span className="font-medium">{name}</span>{" "}
        {process.proposed ? (
          <>
            wants to change <span className="font-medium">{process.name}</span>.
          </>
        ) : (
          <>
            wants to add <span className="font-medium">{process.name}</span>. It cannot run until you approve it.
          </>
        )}
      </p>
      {process.proposed ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {changes.map((change) => (
            <div key={change.field} className="contents">
              <dt className="text-text-muted">{change.field}</dt>
              <dd className="min-w-0 font-mono break-words whitespace-pre-wrap">
                <span className="text-danger line-through">{change.before || "—"}</span>
                {"\n"}
                <span className="text-success">{change.after || "—"}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          <dt className="text-text-muted">Command</dt>
          <dd className="min-w-0 font-mono break-words whitespace-pre-wrap">{process.command}</dd>
          <dt className="text-text-muted">Folder</dt>
          <dd className="font-mono">{process.cwd || "The worktree's root"}</dd>
          {Object.keys(process.env).length > 0 && (
            <>
              <dt className="text-text-muted">Environment</dt>
              <dd className="font-mono whitespace-pre-wrap">{formatEnv(process.env)}</dd>
            </>
          )}
          <dt className="text-text-muted">On crash</dt>
          <dd>{process.autoRestart ? "Restarts" : "Stays down"}</dd>
        </dl>
      )}
      <div className="flex gap-2">
        <Button variant="primary" className="text-[12px]" onClick={() => void processes.decide("approve", process)}>
          {process.proposed ? "Apply change" : "Approve"}
        </Button>
        <Button variant="ghost" className="text-[12px]" onClick={() => void processes.decide("reject", process)}>
          {process.proposed ? "Discard" : "Reject"}
        </Button>
      </div>
    </section>
  );
}
