import {
  ArrowsClockwiseIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { Button, IconButton } from "../chrome/kit";
import { ProcessDialog } from "../chrome/ProcessDialog";
import { ProcessDot } from "../chrome/ProcessDot";
import { deleteConfirm, type Processes } from "../hooks/useProcesses";
import {
  awaitsUser,
  formatEnv,
  isLive,
  specChanges,
  specOf,
  stateLabel,
  type Process,
} from "../lib/processes";
import type { Session } from "../lib/types";
import { ProcessTerminal } from "./ProcessTerminal";

type Props = {
  processId: string;
  processes: Processes;
  /** Every session, to name the agent that wrote a command. */
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
};

/** One command, full height: how it stands, its controls, and its terminal. */
export function ProcessView({ processId, processes, sessions, onConfirm }: Props) {
  const [editing, setEditing] = useState(false);
  const process = processes.processes?.find((p) => p.id === processId);
  if (processes.processes === null) return null;
  if (!process) {
    return <p className="p-10 text-center text-kumo-subtle">This command was deleted.</p>;
  }
  const { run } = processes;
  const live = isLive(process);
  const asking = awaitsUser(process);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline px-4 py-2.5">
        <ProcessDot process={process} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-[14px] font-semibold">{process.name}</h1>
            <span className="shrink-0 text-[12px] text-kumo-subtle">{stateLabel(process)}</span>
          </div>
          <div className="truncate font-mono text-[11px] text-kumo-subtle" title={process.command}>
            {process.cwd ? `${process.cwd} $ ` : "$ "}
            {process.command}
          </div>
        </div>
        {!asking && (
          <div className="flex shrink-0 items-center gap-0.5">
            {process.state === "running" && (
              <IconButton icon={PauseIcon} label="Pause" title="Pause" onClick={() => void run("pause", process)} />
            )}
            {process.state === "paused" && (
              <IconButton icon={PlayIcon} label="Resume" title="Resume" onClick={() => void run("resume", process)} />
            )}
            {(process.state === "running" || process.state === "paused") && (
              <IconButton
                icon={ArrowsClockwiseIcon}
                label="Restart"
                title="Restart"
                onClick={() => void run("restart", process)}
              />
            )}
            {live ? (
              <Button icon={StopIcon} className="text-[12px]" onClick={() => void run("stop", process)}>
                Stop
              </Button>
            ) : (
              <Button icon={PlayIcon} variant="primary" className="text-[12px]" onClick={() => void run("start", process)}>
                Start
              </Button>
            )}
          </div>
        )}
        <IconButton icon={PencilSimpleIcon} label="Edit" title="Edit" onClick={() => setEditing(true)} />
        <IconButton icon={TrashIcon} label="Delete" title="Delete" onClick={() => onConfirm(deleteConfirm(process))} />
      </header>

      {asking && <ApprovalCard process={process} sessions={sessions} processes={processes} />}
      {processes.error && (
        <p role="alert" className="shrink-0 border-b border-hairline px-4 py-2 text-[12px] text-kumo-danger">
          {processes.error}
        </p>
      )}

      <div className="min-h-0 flex-1">
        <ProcessTerminal process={process} />
      </div>

      {editing && (
        <ProcessDialog workspaceId={process.workspaceId} process={process} onClose={() => setEditing(false)} />
      )}
    </div>
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
  const { run } = processes;
  return (
    <section
      aria-label="Waiting for your approval"
      className="m-3 flex shrink-0 flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-kumo-warning/40"
    >
      <p>
        <span className="font-medium">{name}</span>{" "}
        {process.proposed ? "wants to change this command." : "wants to add this command. It cannot run until you approve it."}
      </p>
      {process.proposed ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          {changes.map((change) => (
            <div key={change.field} className="contents">
              <dt className="text-kumo-subtle">{change.field}</dt>
              <dd className="min-w-0 font-mono break-words whitespace-pre-wrap">
                <span className="text-kumo-danger line-through">{change.before || "—"}</span>
                {"\n"}
                <span className="text-kumo-success">{change.after || "—"}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
          <dt className="text-kumo-subtle">Command</dt>
          <dd className="min-w-0 font-mono break-words whitespace-pre-wrap">{process.command}</dd>
          <dt className="text-kumo-subtle">Folder</dt>
          <dd className="font-mono">{process.cwd || "Workspace root"}</dd>
          {Object.keys(process.env).length > 0 && (
            <>
              <dt className="text-kumo-subtle">Environment</dt>
              <dd className="font-mono whitespace-pre-wrap">{formatEnv(process.env)}</dd>
            </>
          )}
          <dt className="text-kumo-subtle">Starts</dt>
          <dd>
            {[process.autoStart ? "with Crew" : "by hand", process.autoRestart ? "restarts on crash" : null]
              .filter(Boolean)
              .join(", ")}
          </dd>
        </dl>
      )}
      <div className="flex gap-2">
        <Button variant="primary" className="text-[12px]" onClick={() => void run("approve", process)}>
          {process.proposed ? "Apply change" : "Approve"}
        </Button>
        <Button variant="ghost" className="text-[12px]" onClick={() => void run("reject", process)}>
          {process.proposed ? "Discard" : "Reject"}
        </Button>
      </div>
    </section>
  );
}
