import type { ApprovalView } from "../../lib/approvals";
import type { ApprovalDecision } from "../../lib/blocks";

/**
 * An approval's headline, whole: it never gives way to what sits beside it.
 * The server beside it truncates first; a reason goes on a line of its own.
 * Once decided it says what came of it, "Edited a.rs" or "Didn't edit a.rs",
 * so nothing else on the line has to.
 */
export function ApprovalTitle({ view, decided }: { view: ApprovalView; decided?: ApprovalDecision | undefined }) {
  const text = decided === undefined ? view.headline : decided === "deny" ? view.refused : view.done;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={`max-w-full shrink-0 truncate ${decided === undefined ? "font-medium" : ""}`}>{text}</span>
        {view.aside ? (
          <span className="min-w-0 truncate text-[12.5px] text-text-muted" title={view.aside}>
            {view.aside}
          </span>
        ) : null}
        {/* The one thing the line cannot say: it will not ask again. */}
        {decided === "always" ? <span className="shrink-0 text-[12.5px] text-text-muted">Always allowed</span> : null}
      </span>
      {view.subtitle ? (
        <span className="line-clamp-2 text-[12.5px] leading-[17px] text-text-muted" title={view.subtitle}>
          {view.subtitle}
        </span>
      ) : null}
    </span>
  );
}
