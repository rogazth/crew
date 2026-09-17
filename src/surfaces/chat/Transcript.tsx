import { useLayoutEffect, useMemo, useRef } from "react";
import { isOpen, type Answers, type ApprovalDecision, type Block, type TurnUsage } from "../../lib/blocks";
import { dayLabel } from "../../lib/time";
import { ActivityGroup, ThinkingLine } from "./Activity";
import { AssistantMessage, DateBreak, Note, TurnFooter, UserMessage } from "./Message";

const NEAR_BOTTOM_PX = 16;
/** A gap this long between messages gets a date line, like a chat app. */
const DATE_BREAK_MS = 30 * 60_000;

type Row =
  | { kind: "message"; block: Block }
  | { kind: "activity"; id: string; blocks: Block[] }
  | { kind: "footer"; id: string; usage: TurnUsage; at?: number }
  | { kind: "date"; id: string; at: number };

type Speaker = "user" | "agent" | "meta";

type Props = {
  blocks: Block[];
  working: boolean;
  /** Older blocks exist before the first one held; the header offers them. */
  more: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

const ACTIVITY_ROLES = new Set(["tool", "approval", "question", "reasoning"]);

function speaker(row: Row): Speaker {
  if (row.kind === "activity" || row.kind === "footer") return "agent";
  if (row.kind === "date") return "meta";
  if (row.block.role === "user") return "user";
  if (row.block.role === "system") return "meta";
  return "agent";
}

function groupRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  let activity: Block[] = [];
  let lastAt: number | undefined;
  const flush = () => {
    if (activity.length === 0) return;
    rows.push({ kind: "activity", id: activity[0]!.id, blocks: activity });
    activity = [];
  };
  for (const block of blocks) {
    if (ACTIVITY_ROLES.has(block.role)) {
      activity.push(block);
      continue;
    }
    if (block.role === "assistant" && !block.text && block.streaming) continue;
    if (block.hidden) continue;
    flush();
    if (block.role === "user" && block.at !== undefined) {
      if (lastAt === undefined || block.at - lastAt > DATE_BREAK_MS) {
        rows.push({ kind: "date", id: `date-${block.id}`, at: block.at });
      }
    }
    rows.push({ kind: "message", block });
    if (block.role === "assistant" && block.usage && !block.streaming) {
      rows.push({
        kind: "footer",
        id: `footer-${block.id}`,
        usage: block.usage,
        ...(block.at !== undefined ? { at: block.at } : {}),
      });
    }
    if (block.at !== undefined) lastAt = block.at;
  }
  flush();
  return rows;
}

/** Same speaker 6, a change of speaker 20, meta 12; the footer hugs its reply. */
function gapBefore(prev: Row | undefined, current: Row): string {
  if (!prev) return "";
  if (current.kind === "footer") return "mt-1.5";
  const from = speaker(prev);
  const to = speaker(current);
  if (from === "meta" || to === "meta") return "mt-3";
  if (from === to) return "mt-1.5";
  return "mt-5";
}

/** The pending tool row already is the live state; Thinking only fills a true gap. */
function showThinking(blocks: Block[], working: boolean): boolean {
  if (!working) return false;
  const last = blocks.at(-1);
  if (!last) return true;
  if ((last.role === "assistant" || last.role === "reasoning") && last.streaming && last.text) return false;
  if (isOpen(last)) return false;
  return true;
}

/** Stick-to-bottom scroller. Same 16px threshold as R1. */
export function Transcript({
  blocks,
  working,
  more,
  loadingEarlier,
  onLoadEarlier,
  onApprove,
  onAnswer,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Distance from the bottom, held across a prepend so the page does not jump. */
  const anchor = useRef<number | null>(null);
  const rows = useMemo(() => groupRows(blocks), [blocks]);
  const thinking = showThinking(blocks, working);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };

  const earlier = () => {
    const el = scroller.current;
    anchor.current = el ? el.scrollHeight - el.scrollTop : null;
    onLoadEarlier();
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) {
      // History arrived above: keep the line being read where it was.
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
      return;
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [blocks, thinking]);

  return (
    <div
      ref={scroller}
      data-selectable="blocks"
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="crew-prose px-6 pt-5 pb-7">
        {more && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              disabled={loadingEarlier}
              onClick={earlier}
              className="rounded-chrome px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-hover hover:text-text disabled:text-placeholder"
            >
              {loadingEarlier ? "Loading…" : "Earlier messages"}
            </button>
          </div>
        )}
        {rows.map((row, index) => {
          const className = gapBefore(rows[index - 1], row);
          if (row.kind === "activity") {
            return (
              <div key={row.id} className={className}>
                <ActivityGroup
                  blocks={row.blocks}
                  live={working && index === rows.length - 1}
                  onApprove={onApprove}
                  onAnswer={onAnswer}
                />
              </div>
            );
          }
          if (row.kind === "footer") {
            return (
              <div key={row.id} className={className}>
                <TurnFooter usage={row.usage} {...(row.at !== undefined ? { at: row.at } : {})} />
              </div>
            );
          }
          if (row.kind === "date") {
            return (
              <div key={row.id} className={className}>
                <DateBreak label={dayLabel(row.at)} />
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
          <div className={rows.length > 0 ? (speaker(rows.at(-1)!) === "agent" ? "mt-1.5" : "mt-5") : ""}>
            <ThinkingLine />
          </div>
        )}
      </div>
    </div>
  );
}
