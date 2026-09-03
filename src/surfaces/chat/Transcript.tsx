import { useLayoutEffect, useRef } from "react";
import type { ApprovalDecision, Block } from "../../lib/blocks";
import { ActivityGroup } from "./ActivityLine";
import { Bubble } from "./Bubble";

const NEAR_BOTTOM_PX = 16;

type Row =
  | { kind: "bubble"; block: Block }
  | { kind: "activity"; blocks: Block[] };

type Props = {
  blocks: Block[];
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
};

function speaker(block: Block): "user" | "agent" | "meta" {
  if (block.role === "user") return "user";
  if (block.role === "system") return "meta";
  return "agent";
}

function groupRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    rows.push({ kind: "activity", blocks: activity });
    activity = [];
  };
  for (const block of blocks) {
    if (block.role === "tool" || block.role === "approval") {
      activity.push(block);
      continue;
    }
    flush();
    rows.push({ kind: "bubble", block });
  }
  flush();
  return rows;
}

function rowSpeaker(row: Row): "user" | "agent" | "meta" {
  return row.kind === "activity" ? "agent" : speaker(row.block);
}

function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  const from = rowSpeaker(prev);
  const to = rowSpeaker(current);
  if (from === "meta" || to === "meta") return "mt-3";
  if (from === to) return "mt-1.5";
  return "mt-5";
}

/** Stick-to-bottom scroller. Same 16px threshold as R1. */
export function Transcript({ blocks, onApprove }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const rows = groupRows(blocks);

  return (
    <div
      ref={scroller}
      data-selectable
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl px-6 py-5">
        {rows.map((row, index) => {
          const prev = rows[index - 1];
          const className = gapBefore(prev, row);
          if (row.kind === "activity") {
            return (
              <div key={row.blocks[0]?.id ?? index} className={className}>
                <ActivityGroup blocks={row.blocks} onApprove={onApprove} />
              </div>
            );
          }
          return (
            <div key={row.block.id} className={className}>
              <Bubble block={row.block} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
