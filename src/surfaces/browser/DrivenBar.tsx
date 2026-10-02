import { DriverFace } from "../../chrome/DriverFace";
import type { BrowserLease } from "../../lib/protocol";
import type { Session } from "../../lib/types";

type Props = {
  lease: BrowserLease;
  /** The session behind the lease, once the list has it. */
  driver: Session | undefined;
  onTakeBack: () => void;
};

/**
 * Under the toolbar while a session drives the page: who it is, and a way to
 * take the page back. Clicking in the page also holds it off for a
 * moment; this lets it go for good.
 */
export function DrivenBar({ lease, driver, onTakeBack }: Props) {
  return (
    <div
      role="status"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-canvas px-3 text-[12px] text-text-muted"
    >
      {driver && <DriverFace session={driver} className="size-4" />}
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
