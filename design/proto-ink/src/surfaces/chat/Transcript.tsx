import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gapBefore, groupRows, showThinking, speaker } from "@crew/fixtures";
import type { Block, Row, Session } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { CREATED_BY_NOTE, agentName, normaliseLetters, useLetterIndex } from "@/lib/chat";
import { useApp } from "@/lib/store";
import { Empty } from "@/ui";
import { Activity, ThinkingLine } from "./Activity";
import { AgentThread } from "./AgentThread";
import {
  AssistantMessage,
  DateBreak,
  SystemNote,
  TurnFooter,
  UserMessage,
} from "./MessageRow";
import { HotCardContext } from "./context";

/** Rows painted at once; the reader pulls more by scrolling up. */
const PAGE = 60;
const PREFETCH_PX = 600;
const STICK_PX = 16;

type Segment = { id: string; agent: boolean; rows: Row[] };

/** Message rows carry their id on the block; every other row carries its own. */
const rowId = (row: Row): string => (row.kind === "message" ? row.block.id : row.id);

/**
 * Consecutive agent rows share one rail, which is what marks the turn. A letter
 * thread hangs off the same rail even though `speaker()` calls it meta — it is
 * something the agent did, and floating it free of the rail reads as a third
 * party in the conversation.
 */
function toSegments(rows: Row[]): Segment[] {
  const out: Segment[] = [];
  for (const row of rows) {
    const agent = speaker(row) === "agent" || row.kind === "agent-thread";
    const last = out.at(-1);
    if (last && last.agent && agent) last.rows.push(row);
    else out.push({ id: rowId(row), agent, rows: [row] });
  }
  return out;
}

export function Transcript({
  session,
  blocks,
  working,
}: {
  session: Session;
  blocks: Block[];
  working: boolean;
}) {
  const { sessions, focus, actions } = useApp();
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const anchor = useRef<number | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [focusId, setFocusId] = useState<string | null>(null);

  const resolve = useCallback((id: string) => agentName(id, sessions), [sessions]);

  const index = useLetterIndex(sessions);

  const { rows, waiting } = useMemo(() => {
    // "Created by X" is chrome now, not prose; the header above owns it.
    const kept = blocks.filter(
      (block) => !(block.role === "system" && CREATED_BY_NOTE.test(block.text)),
    );
    const normalised = normaliseLetters(kept, index);
    return {
      rows: groupRows(normalised.blocks, { resolveAgent: resolve }),
      waiting: normalised.waiting,
    };
  }, [blocks, resolve, index]);

  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(rows.length - limit) : rows;
  const segments = useMemo(() => toSegments(visible), [visible]);

  const hot = useMemo(() => {
    let approval: string | null = null;
    let question: string | null = null;
    for (const block of blocks) {
      if (block.approval && !block.approval.decided) approval = block.id;
      if (block.question && !block.question.answers && !block.question.dismissed) {
        question = block.id;
      }
    }
    return { approval, question };
  }, [blocks]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    // A transcript opens at the bottom, so something is always half-cut at the
    // top edge. Fading it says "there is more" instead of "this is broken".
    if (node.scrollTop > 4) node.dataset["scrolled"] = "";
    else delete node.dataset["scrolled"];
    stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
    if (node.scrollTop < PREFETCH_PX && rows.length > limit) {
      anchor.current = node.scrollHeight;
      setLimit((value) => value + PAGE);
    }
  };

  // Growing the list upwards must not move the line the reader is on.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || anchor.current === null) return;
    node.scrollTop += node.scrollHeight - anchor.current;
    anchor.current = null;
  }, [limit]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !stuck.current) return;
    node.scrollTop = node.scrollHeight;
    if (node.scrollTop > 4) node.dataset["scrolled"] = "";
  }, [blocks, session.id]);

  // Images, fonts and highlighting settle after paint; keep the bottom pinned.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) node.scrollTop = node.scrollHeight;
    });
    const content = node.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setLimit(PAGE);
    stuck.current = true;
  }, [session.id]);

  // A search hit scrolls its block into view, opens whatever folded it, and
  // fades out behind it.
  useEffect(() => {
    if (!focus || focus.sessionId !== session.id) return;
    const index = rows.findIndex(
      (row) =>
        rowId(row) === focus.blockId ||
        (row.kind === "activity" && row.blocks.some((b) => b.id === focus.blockId)) ||
        (row.kind === "agent-thread" && row.messages.some((m) => m.block.id === focus.blockId)),
    );
    if (index >= 0) setLimit(Math.max(PAGE, rows.length - index + 10));
    setFocusId(focus.blockId);
    stuck.current = false;
    const raf = requestAnimationFrame(() => {
      const node = scroller.current?.querySelector<HTMLElement>(`[data-block="${focus.blockId}"]`);
      node?.scrollIntoView({ block: "center" });
    });
    const clear = window.setTimeout(() => {
      setFocusId(null);
      actions.clearFocus();
    }, 2_000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(clear);
    };
  }, [focus, session.id, rows, actions]);

  // Cmd+A belongs to the transcript while the transcript is what you are reading:
  // it selects the conversation, not the window. A field that has focus keeps it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "a" || !(event.metaKey || event.ctrlKey)) return;
      const focused = document.activeElement as HTMLElement | null;
      if (
        focused &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA" || focused.isContentEditable)
      ) {
        return;
      }
      const node = scroller.current?.firstElementChild;
      if (!node) return;
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const thinking = showThinking(blocks, working);
  const lastActivity = [...rows].reverse().find((row) => row.kind === "activity");
  const lastActivityId = lastActivity ? rowId(lastActivity) : null;

  if (rows.length === 0) return null;

  return (
    <HotCardContext.Provider value={hot}>
      <div
        ref={scroller}
        tabIndex={-1}
        onScroll={onScroll}
        className="ink-scroll ink-fade-top min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[46rem] px-6 pb-4 pt-6">
          {hasMore && (
            <button
              type="button"
              onClick={() => {
                anchor.current = scroller.current?.scrollHeight ?? null;
                setLimit((value) => value + PAGE);
              }}
              className="ink-noselect mb-4 flex w-full items-center gap-2 text-micro text-quaternary transition-colors hover:text-tertiary"
            >
              <span className="h-px flex-1 bg-[var(--stroke-tertiary)]" />
              <Icon name="chevronUp" size={12} />
              Earlier messages
              <span className="h-px flex-1 bg-[var(--stroke-tertiary)]" />
            </button>
          )}

          {segments.map((segment, index) => {
            const previous = index > 0 ? segments[index - 1]!.rows.at(-1) : undefined;
            const gap = gapBefore(previous, segment.rows[0]!);
            if (!segment.agent) {
              return (
                <div key={segment.id} style={{ marginTop: index === 0 ? 0 : gap }}>
                  {segment.rows.map((row, i) => (
                    <div
                      key={rowId(row)}
                      style={{ marginTop: i === 0 ? 0 : gapBefore(segment.rows[i - 1]!, row) }}
                    >
                      <PlainRow row={row} waiting={waiting} focusId={focusId} />
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div
                key={segment.id}
                style={{ marginTop: index === 0 ? 0 : gap }}
                className="relative pl-5"
              >
                <span
                  aria-hidden
                  className="ink-noselect absolute bottom-0 left-[1px] top-[3px] w-px bg-[var(--stroke-tertiary)]"
                />
                {segment.rows.map((row, i) => (
                  <div
                    key={rowId(row)}
                    style={{ marginTop: i === 0 ? 0 : gapBefore(segment.rows[i - 1]!, row) }}
                  >
                    <AgentRow
                      row={row}
                      sessionId={session.id}
                      isLast={rowId(row) === lastActivityId}
                      focusId={focusId}
                      waiting={waiting}
                    />
                  </div>
                ))}
              </div>
            );
          })}

          {thinking && (
            <div className="relative mt-5 pl-5">
              <span
                aria-hidden
                className="ink-noselect absolute bottom-0 left-[1px] top-[3px] w-px bg-[var(--stroke-tertiary)]"
              />
              <ThinkingLine since={Date.now()} />
            </div>
          )}
        </div>
      </div>
    </HotCardContext.Provider>
  );
}

function PlainRow({
  row,
  waiting,
  focusId,
}: {
  row: Row;
  waiting: Set<string>;
  focusId: string | null;
}) {
  switch (row.kind) {
    case "date":
      return <DateBreak at={row.at} />;
    case "agent-thread":
      return <AgentThread row={row} waiting={waiting} focusId={focusId} />;
    case "message":
      return row.block.role === "user" ? (
        <UserMessage block={row.block} />
      ) : (
        <SystemNote block={row.block} />
      );
    default:
      return null;
  }
}

function AgentRow({
  row,
  sessionId,
  isLast,
  focusId,
  waiting,
}: {
  row: Row;
  sessionId: string;
  isLast: boolean;
  focusId: string | null;
  waiting: Set<string>;
}) {
  switch (row.kind) {
    case "activity":
      return (
        <Activity blocks={row.blocks} sessionId={sessionId} isLast={isLast} focusId={focusId} />
      );
    case "footer":
      return <TurnFooter usage={row.usage} {...(row.at !== undefined ? { at: row.at } : {})} />;
    case "message":
      return <AssistantMessage block={row.block} focused={focusId === row.block.id} />;
    case "agent-thread":
      return <AgentThread row={row} waiting={waiting} focusId={focusId} />;
    default:
      return null;
  }
}

export function EmptyTranscript({ name }: { name: string }) {
  return (
    <Empty
      icon="message"
      title={`Nothing yet with ${name}`}
      description="Send the first message. Mention a file with @ to give it something to read."
      className={cx("flex-1")}
    />
  );
}
