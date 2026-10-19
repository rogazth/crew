// PROTOTYPE — throwaway. The Commands page with nothing on it, under the
// redesign: a soft card that says what goes here and gives three examples.
// Still, on purpose: an empty page has nothing to animate.
import { LayersIcon } from "lucide-react";

const EXAMPLES = ["npm run dev", "cargo watch -x test", "docker compose up"];

export function EmptyCommands() {
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
      <div className="flex flex-wrap justify-center gap-1.5">
        {EXAMPLES.map((example) => (
          <code key={example} className="ds-empty-example">
            <span className="mr-1.5 text-placeholder select-none">$</span>
            {example}
          </code>
        ))}
      </div>
    </div>
  );
}
