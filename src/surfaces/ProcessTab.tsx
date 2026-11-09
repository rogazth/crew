import { GitBranchIcon, PlayIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { BackLink, ButtonGroup, GroupButton, PAGE_TITLE } from "../chrome/kit";
import { ServedLink } from "../chrome/ServedLink";
import type { Processes } from "../hooks/useProcesses";
import { isLive, rerunEnv, runIn, servedUrl, type Process } from "../lib/processes";
import { ProcessTerminal } from "./ProcessTerminal";

type Props = {
  processId: string;
  /** The run's worktree; null is the main checkout. */
  worktree: string | null;
  /** What that worktree is called; null leaves it out (a workspace of one worktree). */
  place: string | null;
  processes: Processes;
  onBack: () => void;
  /** What the way back says, when it leads somewhere other than where the user came from. */
  backLabel?: string;
};

/**
 * One run of a command, laid out as the command's page is: the way back, the
 * command as the title with how its run stands and its controls, then its
 * output, filled like the page's fields. In a tab of its own, beside the
 * agents in its worktree, or a level under the list in Commands.
 */
export function ProcessTab({ processId, worktree, place, processes, onBack, backLabel }: Props) {
  const process = processes.processes?.find((p) => p.id === processId);
  if (processes.processes === null) return null;
  if (!process) {
    return <p className="p-10 text-center text-text-muted">This service was deleted.</p>;
  }
  const run = runIn(process, worktree);

  return (
    // The command page's measure: going back and forth, nothing moves.
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-col gap-6 px-10 pt-12 pb-8">
      <div className="flex shrink-0 flex-col gap-2">
        <BackLink onClick={onBack} className="mb-2" {...(backLabel && { label: backLabel })} />
        <ProcessHeader process={process} worktree={worktree} place={place} processes={processes} />
        {processes.error && (
          <p role="alert" className="px-1 text-[12px] text-danger">
            {processes.error}
          </p>
        )}
      </div>
      <section aria-label="Output" className="min-h-0 flex-1 overflow-hidden rounded-lg">
        <ProcessTerminal process={process} worktree={worktree} run={run} surface="card" />
      </section>
    </div>
  );
}

/**
 * The run's title block: the command's name, under it where it runs (with more
 * than one worktree) and what it serves, and its controls, alike in one group,
 * to the right. How it stands is the controls': Stop while it runs, Start once not.
 */
export function ProcessHeader({
  process,
  worktree,
  place,
  processes,
}: {
  process: Process;
  worktree: string | null;
  place: string | null;
  processes: Pick<Processes, "run">;
}) {
  const { run: act } = processes;
  const run = runIn(process, worktree);
  const live = isLive(run);
  const url = servedUrl(run);
  return (
    <header data-process-header className="flex items-start gap-3 px-1">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className={`truncate ${PAGE_TITLE}`}>{process.name}</h1>
        {(place !== null || url) && (
          <div className="flex min-w-0 items-center gap-3">
            {place !== null && (
              <span data-place className="flex shrink-0 items-center gap-1 text-[12.5px] text-text-muted">
                <GitBranchIcon aria-hidden className="size-3.5 text-icon" />
                {place}
              </span>
            )}
            {url && <ServedLink url={url} className="-ml-1.5 shrink-0" />}
          </div>
        )}
      </div>
      <ButtonGroup label={`Control ${process.name}`}>
        {run?.state === "paused" && (
          <GroupButton icon={PlayIcon} onClick={() => void act("resume", process, worktree)}>
            Resume
          </GroupButton>
        )}
        {(run?.state === "running" || run?.state === "paused") && (
          <GroupButton icon={RotateCwIcon} onClick={() => void act("restart", process, worktree)}>
            Restart
          </GroupButton>
        )}
        {live ? (
          <GroupButton icon={SquareIcon} onClick={() => void act("stop", process, worktree)}>
            Stop
          </GroupButton>
        ) : (
          // With the env it last ran on: a run moved to its own port comes back on it.
          <GroupButton icon={PlayIcon} onClick={() => void act("start", process, worktree, rerunEnv(process, run))}>
            Start
          </GroupButton>
        )}
      </ButtonGroup>
    </header>
  );
}
