import { ListIcon, PlayIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { Button, IconButton } from "../chrome/kit";
import { ProcessDot } from "../chrome/ProcessDot";
import { ServedLink } from "../chrome/ServedLink";
import type { Processes } from "../hooks/useProcesses";
import { isLive, runIn, servedUrl, stateLabel, stateTone, type Process } from "../lib/processes";
import { ProcessTerminal } from "./ProcessTerminal";

type Props = {
  processId: string;
  /** The run's worktree; null is the main checkout. */
  worktree: string | null;
  /** What that worktree is called: its branch. */
  place: string;
  processes: Processes;
  onOpenCommands: () => void;
};

/**
 * One run of a command in a tab of its worktree, beside the agents working
 * there: how it stands, its three controls, and its terminal. Defining and
 * approving commands is the Commands page's; this is for watching one.
 */
export function ProcessTab({ processId, worktree, place, processes, onOpenCommands }: Props) {
  const process = processes.processes?.find((p) => p.id === processId);
  if (processes.processes === null) return null;
  if (!process) {
    return <p className="p-10 text-center text-text-muted">This command was deleted.</p>;
  }
  const run = runIn(process, worktree);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ProcessHeader process={process} worktree={worktree} place={place} processes={processes} onOpenCommands={onOpenCommands} />

      {!process.approved && (
        <p data-process-notice className="shrink-0 border-b border-hairline px-4 py-2 text-[12px] text-warning">
          An agent wrote this command. It cannot run until you approve it in{" "}
          <button type="button" className="underline underline-offset-2" onClick={onOpenCommands}>
            Commands
          </button>
          .
        </p>
      )}
      {processes.error && (
        <p role="alert" className="shrink-0 border-b border-hairline px-4 py-2 text-[12px] text-danger">
          {processes.error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <ProcessTerminal process={process} worktree={worktree} run={run} />
      </div>
    </div>
  );
}

/** How the run stands, where, what it runs and its controls: the tab's top. */
export function ProcessHeader({
  process,
  worktree,
  place,
  processes,
  onOpenCommands,
}: {
  process: Process;
  worktree: string | null;
  place: string;
  processes: Pick<Processes, "run">;
  onOpenCommands: () => void;
}) {
  const { run: act } = processes;
  const run = runIn(process, worktree);
  const live = isLive(run);
  const url = servedUrl(run);
  const own = Object.entries(run?.env ?? {}).map(([key, value]) => `${key}=${value} `);
  return (
    <header data-process-header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2">
      <ProcessDot run={run} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h1 className="truncate text-[13px] font-semibold">{process.name}</h1>
          <span data-run-state={run?.state ?? "stopped"} data-tone={stateTone(run)} className="shrink-0 text-[12px] text-text-muted">
            {stateLabel(run)}<span data-sep> · {place}</span>
          </span>
          <span data-place className="hidden">{place}</span>
          {url && <ServedLink url={url} className="-my-0.5 self-center" />}
        </div>
        <div className="truncate font-mono text-[11px] text-text-muted" title={process.command}>
          {process.cwd ? `${process.cwd} $ ` : "$ "}
          {own.join("")}
          {process.command}
        </div>
      </div>
      {process.approved && (
        <div className="flex shrink-0 items-center gap-0.5">
          {run?.state === "paused" && (
            <IconButton icon={PlayIcon} label="Resume" title="Resume" onClick={() => void act("resume", process, worktree)} />
          )}
          {(run?.state === "running" || run?.state === "paused") && (
            <IconButton icon={RotateCwIcon} label="Restart" title="Restart" onClick={() => void act("restart", process, worktree)} />
          )}
          {live ? (
            <Button icon={SquareIcon} className="text-[12px]" onClick={() => void act("stop", process, worktree)}>
              Stop
            </Button>
          ) : (
            <Button icon={PlayIcon} variant="primary" className="text-[12px]" onClick={() => void act("start", process, worktree)}>
              Start
            </Button>
          )}
        </div>
      )}
      <IconButton icon={ListIcon} label="All commands" title="All commands" onClick={onOpenCommands} />
    </header>
  );
}
