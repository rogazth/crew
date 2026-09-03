import { useLayoutEffect, useMemo, useRef } from "react";
import type { ApprovalDecision, Block } from "../../lib/blocks";
import { ActivityGroup, ThinkingLine, isOpen } from "./ActivityLine";
import { AssistantMessage, Note, UserMessage } from "./Message";

const NEAR_BOTTOM_PX = 16;

type Row =
  | { kind: "message"; block: Block }
  | { kind: "activity"; id: string; blocks: Block[] };

type Speaker = "user" | "agent" | "meta";

type Props = {
  blocks: Block[];
  working: boolean;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
};

function speaker(row: Row): Speaker {
  if (row.kind === "activity") return "agent";
  if (row.block.role === "user") return "user";
  if (row.block.role === "system") return "meta";
  return "agent";
}

function groupRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    rows.push({ kind: "activity", id: activity[0]!.id, blocks: activity });
    activity = [];
  };
  for (const block of blocks) {
    if (block.role === "tool" || block.role === "approval") {
      activity.push(block);
      continue;
    }
    if (block.role === "assistant" && !block.text && block.streaming) continue;
    flush();
    rows.push({ kind: "message", block });
  }
  flush();
  return rows;
}

/** Same speaker 6, a change of speaker 16, notes 12. */
function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return "mt-3";
  if (from === to) return "mt-1.5";
  return "mt-4";
}

/** The pending tool row already is the live state; Thinking only fills a true gap. */
function showThinking(blocks: Block[], working: boolean): boolean {
  if (!working) return false;
  const last = blocks.at(-1);
  if (!last) return true;
  if (last.role === "assistant" && last.streaming && last.text) return false;
  if (isOpen(last)) return false;
  return true;
}

/** Stick-to-bottom scroller. Same 16px threshold as R1. */
export function Transcript({ blocks, working, onApprove }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const rows = useMemo(() => groupRows(blocks), [blocks]);
  const thinking = showThinking(blocks, working);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks, thinking]);

  return (
    <div
      ref={scroller}
      data-selectable
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="crew-prose mx-auto max-w-[720px] px-6 pt-5 pb-2">
        {rows.map((row, index) => {
          const className = gapBefore(rows[index - 1], row);
          if (row.kind === "activity") {
            return (
              <div key={row.id} className={className}>
                <ActivityGroup blocks={row.blocks} onApprove={onApprove} />
              </div>
            );
          }
          const { block } = row;
          return (
            <div key={block.id} className={className}>
              {block.role === "user" ? (
                <UserMessage block={block} />
              ) : block.role === "system" ? (
                <Note block={block} />
              ) : (
                <AssistantMessage block={block} />
              )}
            </div>
          );
        })}
        {thinking && (
          <div className={rows.length > 0 ? (speaker(rows.at(-1)!) === "agent" ? "mt-1.5" : "mt-4") : ""}>
            <ThinkingLine />
          </div>
        )}
      </div>
    </div>
  );
}
