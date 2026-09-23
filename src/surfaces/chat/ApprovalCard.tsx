import { lazy, memo, Suspense, useEffect, useRef } from "react";
import { approvalHeadline, approvalKey } from "../../lib/approval";
import type { ApprovalDecision, Block } from "../../lib/blocks";

/** The diff renderer is ~300 kB and most turns never raise a card; it loads with the first one. */
const ApprovalBody = lazy(() => import("./ApprovalBody").then((m) => ({ default: m.ApprovalBody })));

type Props = {
  block: Block;
  /** Only the newest open card takes Enter and Escape. */
  hot?: boolean;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
};

/**
 * The call, shown as what it will do: a diff for an edit, the command for a
 * shell call, the raw input for anything else. Allow is the default action.
 */
export const ApprovalCard = memo(function ApprovalCard({ block, hot = false, onApprove }: Props) {
  const approval = block.approval;
  const requestId = approval?.requestId;
  const name = approval?.name ?? "";
  const input = approval?.input;
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hot) card.current?.focus();
  }, [hot]);

  useEffect(() => {
    if (!hot || requestId == null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const decision = approvalKey(event, target?.matches("input, textarea, [contenteditable]") ?? false);
      if (!decision) return;
      event.preventDefault();
      onApprove(requestId, decision);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hot, requestId, onApprove]);

  if (requestId == null) return null;

  return (
    <div ref={card} tabIndex={-1} className="crew-card my-1.5 outline-none">
      <p className="text-[13px] leading-[18px] text-text-muted">{approvalHeadline(name, input, block.text)}</p>
      <Suspense fallback={null}>
        <ApprovalBody name={name} input={input} />
      </Suspense>
      <div className="flex items-center justify-end gap-1.5">
        <button type="button" onClick={() => onApprove(requestId, "deny")} className="crew-btn">
          Deny
        </button>
        <button type="button" onClick={() => onApprove(requestId, "always")} className="crew-btn">
          Always allow
        </button>
        <button type="button" onClick={() => onApprove(requestId, "allow")} className="crew-btn crew-btn-primary">
          Allow
        </button>
      </div>
    </div>
  );
});
