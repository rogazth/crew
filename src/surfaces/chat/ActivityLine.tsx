import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { Spinner } from "../../chrome/icons";
import type { ApprovalDecision, Block } from "../../lib/blocks";

type Props = {
  blocks: Block[];
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
};

function isOpen(block: Block): boolean {
  if (block.role === "tool") return block.tool?.status === "pending";
  if (block.role === "approval") return block.approval != null && !block.approval.decided;
  return false;
}

/** Consecutive tools collapse to muted 12px lines. More than three settled ones fold. */
export function ActivityGroup({ blocks, onApprove }: Props) {
  const [open, setOpen] = useState(false);
  const pending = blocks.filter(isOpen);
  const settled = blocks.filter((block) => !isOpen(block));
  const hidden = settled.length > 3 ? settled.slice(0, -3) : [];
  const visible = hidden.length > 0 && !open ? [...settled.slice(-3), ...pending] : blocks;

  return (
    <div className="flex flex-col gap-0.5">
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="w-fit text-[12px] leading-4 text-text-muted transition-colors hover:text-text"
        >
          {open ? "Hide earlier" : `${hidden.length} earlier`}
        </button>
      )}
      {visible.map((block) => (
        <ActivityLine key={block.id} block={block} onApprove={onApprove} />
      ))}
    </div>
  );
}

function ActivityLine({
  block,
  onApprove,
}: {
  block: Block;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const pending = isOpen(block);
  const failed = block.tool?.status === "failed" || block.approval?.decided === "deny";
  const label = block.tool?.title ?? block.text;
  const requestId = block.approval?.requestId;
  const undecided = block.role === "approval" && requestId != null && !block.approval?.decided;

  return (
    <div className="flex min-h-5 items-center gap-2 text-[12px] leading-4">
      {pending && <Spinner className="size-3 text-text-muted" />}
      <span className={failed ? "text-danger" : "text-text-muted"}>{label}</span>
      {undecided && requestId != null && (
        <span className="flex items-center gap-1">
          <Button variant="secondary" size="xs" onClick={() => onApprove(requestId, "deny")}>
            Deny
          </Button>
          <Button variant="primary" size="xs" onClick={() => onApprove(requestId, "allow")}>
            Allow
          </Button>
        </span>
      )}
    </div>
  );
}
