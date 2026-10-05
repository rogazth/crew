import { BotIcon, FolderPlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import { commandKeys } from "../lib/commands";
import type { Step } from "../lib/gettingStarted";
import { SidebarRow } from "./SidebarRow";

/** Home's ways to start, over its sessions: there are no worktrees to add one to. */
export function HomeActions({
  onNewSession,
  onNewBot,
  onOpenFolder,
}: {
  onNewSession: () => void;
  onNewBot: () => void;
  onOpenFolder: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <SidebarRow icon={SquarePenIcon} label="New session" keys={commandKeys("new-session")} onClick={onNewSession} />
      <SidebarRow icon={BotIcon} label="New bot" keys={commandKeys("new-bot")} onClick={onNewBot} />
      <SidebarRow icon={FolderPlusIcon} label="Open a project folder" keys={commandKeys("open-workspace")} onClick={onOpenFolder} />
    </div>
  );
}

/** The tour, folded into the panel's foot: how far along, and what comes next. */
export function TourFoot({ steps, onDismiss }: { steps: Step[]; onDismiss: () => void }) {
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  return (
    <div data-tour className="group/tour shrink-0 border-t border-hairline px-3 py-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="min-w-0 flex-1 font-medium">{done === 0 ? "Get started" : "Getting started"}</span>
        <span className="text-text-muted tabular-nums">
          {done}/{steps.length}
        </span>
        <button
          type="button"
          aria-label="Hide getting started"
          title="Hide"
          onClick={onDismiss}
          className="-mr-1 grid size-5 place-items-center rounded-md text-icon opacity-0 transition-opacity outline-none group-hover/tour:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="mt-2 flex gap-1">
        {steps.map((step) => (
          <span key={step.id} className={`h-1 flex-1 rounded-full ${step.done ? "bg-text" : "bg-border-strong"}`} />
        ))}
      </div>
      {next && <p className="mt-2 truncate text-[12px] text-text-muted">Next: {next.label}</p>}
    </div>
  );
}
