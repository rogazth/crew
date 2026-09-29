import { PlayIcon, PlusIcon, RotateCwIcon, SquareIcon, type LucideIcon as Icon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { ActionMenu } from "./ActionMenu";
import type { Confirm } from "./ConfirmDialog";
import { ProcessDialog } from "./ProcessDialog";
import { ProcessDot } from "./ProcessDot";
import { SortableItem, SortableList } from "./SortableList";
import { deleteConfirm, type Processes } from "../hooks/useProcesses";
import * as api from "../lib/api";
import { isDeleteChord } from "../lib/hotkey";
import { menuFromEvent, type MenuPoint } from "../lib/menu";
import { awaitsUser, isLive, processActions, type Process } from "../lib/processes";
import type { Workspace } from "../lib/types";

type Props = {
  workspace: Workspace;
  processes: Processes;
  /** The one whose page is open. */
  activeId: string | null;
  onOpen: (process: Process) => void;
  onConfirm: (confirm: Confirm) => void;
};

/**
 * The workspace's long-running commands, below its worktrees: dev servers,
 * watchers, workers. Each keeps running with nobody looking; a row opens its
 * output. One an agent wrote waits here for the user to approve it.
 */
export function CommandsSection({ workspace, processes, activeId, onOpen, onConfirm }: Props) {
  const [menu, setMenu] = useState<{ point: MenuPoint; process: Process } | null>(null);
  const [editing, setEditing] = useState<{ process?: Process } | null>(null);
  const list = processes.processes ?? [];
  const { run } = processes;

  const pick = (id: string, process: Process) => {
    if (id === "edit") setEditing({ process });
    else if (id === "delete") onConfirm(deleteConfirm(process));
    else if (id === "copy-command") void navigator.clipboard.writeText(process.command);
    else if (id === "open") onOpen(process);
    else void run(id as api.ProcessCommand | "approve", process);
  };

  return (
    <div className="mt-3" data-commands>
      <div className="flex h-8 items-center gap-0.5 pl-2">
        <span className="min-w-0 flex-1 truncate text-text-muted">Commands</span>
        <HeaderButton icon={PlusIcon} label="New command" onClick={() => setEditing({})} />
      </div>

      {processes.processes !== null && list.length === 0 && (
        <p className="px-2 py-1.5 text-[12px] text-placeholder">
          No commands yet.
        </p>
      )}

      <div className="flex flex-col gap-0.5">
        <SortableList ids={list.map((p) => p.id)} onReorder={processes.reorder}>
          {list.map((process, at) => (
            <SortableItem key={process.id} id={process.id} index={at} group={`processes:${workspace.id}`}>
              <CommandRow
                process={process}
                active={process.id === activeId}
                onOpen={() => onOpen(process)}
                onToggle={() => void run(isLive(process) ? "stop" : "start", process)}
                onRestart={() => void run("restart", process)}
                onMenu={(point) => setMenu({ point, process })}
                onRemove={() => onConfirm(deleteConfirm(process))}
              />
            </SortableItem>
          ))}
        </SortableList>
      </div>

      {processes.error && (
        <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">
          {processes.error}
        </p>
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
        <ProcessDialog workspaceId={workspace.id} process={editing.process} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function HeaderButton({ icon: Glyph, label, onClick }: { icon: Icon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-md text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
    >
      <Glyph className="size-4" />
    </button>
  );
}

/** A command's row: how it stands, its name, and on hover the two things done most. */
function CommandRow({
  process,
  active,
  onOpen,
  onToggle,
  onRestart,
  onMenu,
  onRemove,
}: {
  process: Process;
  active: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRestart: () => void;
  onMenu: (point: MenuPoint) => void;
  onRemove: () => void;
}) {
  const live = isLive(process);
  const asking = awaitsUser(process);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu({ x: rect.left + 8, y: rect.bottom });
    } else if (isDeleteChord(event)) {
      event.preventDefault();
      onRemove();
    }
  }
  return (
    <div className="group/cmd relative">
      <button
        type="button"
        data-nav
        aria-current={active ? "page" : undefined}
        title={process.command}
        onClick={onOpen}
        onContextMenu={(event) => onMenu(menuFromEvent(event))}
        onKeyDown={onKeyDown}
        className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left outline-none transition-colors duration-150 ease-out focus-visible:ring-1 focus-visible:ring-border-strong ${
          active ? "bg-selected" : "hover:bg-hover focus-visible:bg-hover"
        }`}
      >
        <ProcessDot process={process} />
        <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{process.name}</span>
        {asking && (
          <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[11px] text-warning group-hover/cmd:opacity-0">
            Review
          </span>
        )}
      </button>
      {!asking && (
        <span className="absolute top-1 right-1 flex gap-0.5 opacity-0 transition-opacity group-focus-within/cmd:opacity-100 group-hover/cmd:opacity-100">
          {live && process.state !== "starting" && (
            <RowButton icon={RotateCwIcon} label={`Restart ${process.name}`} onClick={onRestart} />
          )}
          <RowButton
            icon={live ? SquareIcon : PlayIcon}
            label={`${live ? "Stop" : "Start"} ${process.name}`}
            onClick={onToggle}
          />
        </span>
      )}
    </div>
  );
}

function RowButton({ icon: Glyph, label, onClick }: { icon: Icon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-md text-text-muted hover:bg-hover hover:text-text"
    >
      <Glyph className="size-3.5 fill-current" />
    </button>
  );
}
