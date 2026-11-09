import { lazy, memo, Suspense, useContext, useEffect, useMemo, useRef } from "react";
import { Button } from "../../chrome/kit";
import { Kbd } from "../../chrome/Kbd";
import { describeApproval } from "../../lib/approvals";
import type { ApprovalDecision, Block } from "../../lib/blocks";
import { approvalIcon } from "./approvalIcon";
import { ApprovalTitle } from "./ApprovalTitle";
import { AlwaysAllow } from "./context";

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
  const always = useContext(AlwaysAllow);
  const view = useMemo(() => describeApproval(name, input, block.text), [name, input, block.text]);
  const Icon = approvalIcon(view);

  useEffect(() => {
    if (hot) card.current?.focus();
  }, [hot]);

  useEffect(() => {
    if (!hot || requestId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // A card under an open thread is not on screen: the keys are the thread's. In a thread, Esc goes back, it never decides.
      if (card.current?.closest("[inert]")) return;
      if (event.key === "Escape" && card.current?.closest("[data-agent-view]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable]")) return;
      if (event.key === "Enter") {
        event.preventDefault();
        onApprove(requestId, "allow");
      } else if (event.key === "Escape") {
        event.preventDefault();
        onApprove(requestId, "deny");
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [hot, requestId, onApprove]);

  if (requestId == null) return null;

  return (
    <div ref={card} tabIndex={-1} className="crew-card my-2 outline-none" data-approval-card>
      {/* The answer sits beside the question, as a page's header holds its button. */}
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
          <Icon className="size-4" />
        </span>
        <ApprovalTitle view={view} />
        <span className="flex shrink-0 items-center gap-1.5">
          <Button className="h-7 px-2.5" {...(hot ? { keys: "esc" } : {})} onClick={() => onApprove(requestId, "deny")}>
            Deny
          </Button>
          <Button variant="primary" className="h-7 px-2.5" onClick={() => onApprove(requestId, "allow")}>
            Allow {hot && <Kbd keys="↵" className="border-white/20 bg-white/10 text-current! opacity-80" />}
          </Button>
        </span>
      </div>
      <Suspense fallback={null}>
        <ApprovalBody name={name} input={input} title={block.text} />
      </Suspense>
      {/* A quiet link under what it would allow: a rule for every call after this one is not the default answer. */}
      {always && (
        <button
          type="button"
          onClick={() => onApprove(requestId, "always")}
          className="-mt-1 self-start text-[12px] text-text-muted transition-colors hover:text-text"
        >
          Always allow
        </button>
      )}
    </div>
  );
});
