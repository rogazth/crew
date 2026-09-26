import { AgentAvatar } from "../../chrome/AgentAvatar";
import type { BrowserLease } from "../../lib/protocol";

type Props = {
  lease: BrowserLease;
  onTakeBack: () => void;
};

/**
 * Under the toolbar while an agent drives the page: who it is, and a way to
 * take the page back. Clicking in the page also holds the agent off for a
 * moment; this lets it go for good.
 */
export function DrivenBar({ lease, onTakeBack }: Props) {
  return (
    <div
      role="status"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-canvas px-3 text-[12px] text-text-muted"
    >
      {lease.sessionId && <AgentAvatar seed={lease.sessionId} className="size-4" />}
      <span className="min-w-0 flex-1 truncate">
        <span className="text-text">{lease.holder}</span> is using this page
      </span>
      <button
        type="button"
        onClick={onTakeBack}
        className="flex h-6 shrink-0 items-center rounded-md px-2 text-text-muted transition-colors hover:bg-hover hover:text-text"
      >
        Take back
      </button>
    </div>
  );
}
