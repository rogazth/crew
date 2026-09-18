import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  gapBefore,
  groupRows,
  showThinking,
  speaker,
  type Block,
  type Row,
} from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { agentTint } from "@/lib/identity";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Icon } from "@/ui/Icon";
import { Pulse } from "@/ui/Pulse";
import { Activity, TurnFooter } from "./Activity";
import { AgentThreadRow, AssistantMessage, DateBreak, SystemNote, UserMessage } from "./MessageRow";

const BOTTOM_THRESHOLD = 16;
const PREFETCH_AT = 600;
const PAGE = 30;

export function Transcript({
  blocks,
  sessionId,
  sessionName,
  working,
}: {
  blocks: Block[];
  sessionId: string;
  sessionName: string;
  working: boolean;
}) {
  const { sessionById, dark, reveal, setReveal } = useStore();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [shown, setShown] = useState(PAGE);
  const [flash, setFlash] = useState<string | null>(null);

  const rows = useMemo(
    () => groupRows(blocks, { resolveAgent: (id) => sessionById(id)?.name ?? id }),
    [blocks, sessionById],
  );

  const start = Math.max(0, rows.length - shown);
  const visible = rows.slice(start);
  const tint = agentTint(sessionName, dark);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    if (el.scrollTop < PREFETCH_AT && start > 0) {
      const before = el.scrollHeight;
      setShown((held) => held + PAGE);
      requestAnimationFrame(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop += scrollerRef.current.scrollHeight - before;
      });
    }
  };

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  useEffect(() => {
    setShown(PAGE);
    stick.current = true;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sessionId]);

  // A search hit scrolls its block into view, unfolds whatever holds it, and
  // fades a highlight behind it.
  useEffect(() => {
    if (!reveal || reveal.sessionId !== sessionId) return;
    const index = rows.findIndex(
      (row) =>
        (row.kind === "message" && row.block.id === reveal.blockId) ||
        (row.kind === "activity" && row.blocks.some((block) => block.id === reveal.blockId)),
    );
    if (index >= 0 && index < start) setShown(rows.length - index + 4);
    setFlash(reveal.blockId);
    const timer = window.setTimeout(() => {
      const target = scrollerRef.current?.querySelector<HTMLElement>(`[data-block="${reveal.blockId}"]`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      stick.current = false;
    }, 60);
    const clear = window.setTimeout(() => {
      setFlash(null);
      setReveal(null);
    }, 2200);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [reveal, sessionId, rows, start, setReveal]);

  const thinking = showThinking(blocks, working);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      onKeyDown={(event) => {
        // Cmd+A belongs to the transcript, not the window.
        if ((event.metaKey || event.ctrlKey) && event.key === "a") {
          const el = scrollerRef.current;
          if (!el) return;
          event.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }}
      tabIndex={-1}
      className="scroller min-h-0 flex-1 outline-none"
    >
      <div className="mx-auto w-full max-w-[860px] px-6 pb-6 pt-4">
        {start > 0 ? (
          <button
            type="button"
            onClick={() => setShown((held) => held + PAGE)}
            className="mx-auto mb-4 flex h-7 items-center gap-1.5 rounded-chip bg-raised px-2.5 text-xs text-ink-52 el-1 hover:text-ink"
          >
            <Icon name="arrowUpRight" size={12} className="rotate-[-45deg]" />
            Earlier messages
          </button>
        ) : (
          rows.length > 0 && (
            <p className="mb-4 select-none text-center text-xs text-ink-38">Beginning of the conversation</p>
          )
        )}

        {visible.map((row, index) => {
          const previous = index === 0 ? rows[start - 1] : visible[index - 1];
          const gap = gapBefore(previous, row);
          const who = speaker(row);
          const firstOfRun = !previous || speaker(previous) !== "agent";
          const isLast = start + index === rows.length - 1;
          const blockId = row.kind === "message" ? row.block.id : row.kind === "activity" ? row.id : row.id;
          const flashing = flash !== null && rowHolds(row, flash);

          if (who === "agent") {
            return (
              <div key={blockId} className="flex w-full gap-3" data-block={blockId}>
                <div className="w-7 shrink-0" style={{ paddingTop: gap }}>
                  {firstOfRun && <Avatar seed={sessionName} size={28} />}
                </div>
                <div
                  className={cx("min-w-0 flex-1 border-l-2 pl-3.5", flashing && "hit-flash rounded-r-card")}
                  style={{ paddingTop: gap, borderColor: tint }}
                >
                  <AgentRow row={row} isLast={isLast} flash={flash} />
                </div>
              </div>
            );
          }

          return (
            <div key={blockId} style={{ paddingTop: gap }} data-block={blockId} className={cx(flashing && "hit-flash rounded-card")}>
              {row.kind === "message" && row.block.role === "user" && !row.block.fromAgent && (
                <UserMessage block={row.block} />
              )}
              {row.kind === "message" && row.block.role === "system" && <SystemNote block={row.block} />}
              {row.kind === "message" && row.block.role === "user" && row.block.fromAgent && (
                <SystemNote block={row.block} />
              )}
              {row.kind === "date" && <DateBreak at={row.at} />}
              {row.kind === "agent-thread" && <AgentThreadRow row={row} sessionId={sessionId} />}
            </div>
          );
        })}

        {thinking && (
          <div className="flex w-full gap-3 pt-5">
            <div className="w-7 shrink-0">
              <Avatar seed={sessionName} size={28} />
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 border-l-2 pl-3.5" style={{ borderColor: tint }}>
              <span className="inline-flex h-7 items-center gap-2 rounded-chip bg-raised px-2.5 text-sm text-ink-52 el-1">
                <Pulse className="text-ink-38" />
                Thinking
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function rowHolds(row: Row, blockId: string): boolean {
  if (row.kind === "message") return row.block.id === blockId;
  if (row.kind === "activity") return row.blocks.some((block) => block.id === blockId);
  return false;
}

function AgentRow({ row, isLast, flash }: { row: Row; isLast: boolean; flash: string | null }) {
  if (row.kind === "activity") {
    return <Activity blocks={row.blocks} isLast={isLast} {...(flash ? { forceOpenId: flash } : {})} />;
  }
  if (row.kind === "footer") {
    return <TurnFooter usage={row.usage} {...(row.at !== undefined ? { at: row.at } : {})} />;
  }
  if (row.kind === "message") return <AssistantMessage block={row.block} />;
  return null;
}
