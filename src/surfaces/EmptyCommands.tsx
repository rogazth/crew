// The Commands page with nothing on it: a soft card that says what goes here
// and offers to add the first one. Still, on purpose: an empty page has nothing to animate.
import { LayersIcon, PlusIcon } from "lucide-react";
import { Button } from "../chrome/kit";

export function EmptyCommands({ onNew }: { onNew: () => void }) {
  return (
    <div className="ds-empty">
      <span className="ds-empty-mark">
        <LayersIcon className="size-5" />
      </span>
      <div className="flex flex-col items-center gap-1">
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-text">No commands yet</span>
        <span className="max-w-[420px] text-[12.5px] leading-[18px] text-text-muted">
          Dev servers and watchers, run in any worktree.
        </span>
      </div>
      <Button variant="primary" icon={PlusIcon} onClick={onNew}>
        New command
      </Button>
    </div>
  );
}
