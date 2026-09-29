import { ServerIcon } from "lucide-react";

type Props = {
  /** Runs up across the workspace's worktrees. */
  live: number;
  /** Commands an agent wrote or wants to change, waiting on the user. */
  asking: number;
  /** Left running by a session that is gone. */
  orphans: number;
  /** The Commands page is the one on screen. */
  open: boolean;
  onToggle: () => void;
};

/**
 * The way to the workspace's commands, at the foot of the sidebar: how many
 * run, and whether anything waits on the user, without opening the page.
 */
export function CommandsButton({ live, asking, orphans, open, onToggle }: Props) {
  const said = [
    live > 0 ? `${live} running` : "none running",
    orphans > 0 ? `${orphans} left running` : null,
    asking > 0 ? `${asking} to review` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      data-nav
      data-tauri-drag-region="false"
      aria-current={open ? "page" : undefined}
      aria-label={`Commands: ${said}`}
      title={`Commands: ${said}`}
      onClick={onToggle}
      className={`flex h-8 w-full items-center gap-2.5 rounded-chrome px-2 text-left outline-none transition-colors duration-150 ease-out focus-visible:ring-1 focus-visible:ring-border-strong ${
        open ? "bg-selected font-medium" : "hover:bg-hover focus-visible:bg-hover"
      }`}
    >
      <ServerIcon className="size-4 shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate">Commands</span>
      {asking > 0 && (
        <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[11px] text-warning">Review</span>
      )}
      {live > 0 && (
        <span
          className={`flex shrink-0 items-center gap-1 text-[11px] tabular-nums ${orphans > 0 ? "text-warning" : "text-text-muted"}`}
        >
          <span className={`size-1.5 rounded-full ${orphans > 0 ? "bg-warning" : "bg-success"}`} />
          {live}
        </span>
      )}
    </button>
  );
}
