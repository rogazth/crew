import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  isOpen,
  type Answers,
  type ApprovalDecision,
  type Block,
} from "../../lib/blocks";
import { gapBefore, groupRows, speaker } from "../../lib/transcriptRows";
import { dayLabel } from "../../lib/time";
import { ActivityGroup, ThinkingLine } from "./Activity";
import {
  AssistantMessage,
  DateBreak,
  Note,
  TurnFooter,
  UserMessage,
} from "./Message";

const NEAR_BOTTOM_PX = 16;
/** How close to the top the reader gets before the page behind it is fetched. */
const PREFETCH_PX = 600;
/** How many frames to wait for a folded phase to mount the row it holds. */
const FOCUS_FRAMES = 20;
type Props = {
  blocks: Block[];
  working: boolean;
  /** False while the tab sits behind another one, where nothing has a size. */
  active: boolean;
  /** Older blocks exist before the first one held; the header offers them. */
  more: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** The last block a search hit sent the reader to: scrolled to once, and
   *  left marked so the phase holding it stays open. */
  focusId: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

/** The pending tool row already is the live state; Thinking only fills a true gap. */
function showThinking(blocks: Block[], working: boolean): boolean {
  if (!working) return false;
  const last = blocks.at(-1);
  if (!last) return true;
  if (
    (last.role === "assistant" || last.role === "reasoning") &&
    last.streaming &&
    last.text
  )
    return false;
  if (isOpen(last)) return false;
  return true;
}

/** Stick-to-bottom scroller. Same 16px threshold as R1. */
export function Transcript({
  blocks,
  working,
  active,
  more,
  loadingEarlier,
  onLoadEarlier,
  focusId,
  onApprove,
  onAnswer,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Where the reader is, measured from the bottom: everything that arrives
   *  arrives above them, so this is the number that must not change. */
  const fromBottom = useRef(0);
  const rows = useMemo(() => groupRows(blocks), [blocks]);
  const thinking = showThinking(blocks, working);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    fromBottom.current = el.scrollHeight - el.scrollTop;
  };

  const place = useCallback(() => {
    const el = scroller.current;
    // A tab behind another one is display:none, where every measurement reads
    // 0; writing one there is what lands the reader at the top of a year of
    // history the moment the tab is shown.
    if (!el || el.clientHeight === 0) return;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Reading something further up: history loading above, or a resync
    // trimming it, must leave that line where it was.
    el.scrollTop = el.scrollHeight - fromBottom.current;
  }, []);

  useLayoutEffect(place, [place, blocks, thinking, active]);

  // Shiki answering, an image resolving, a webfont landing: each one grows the
  // transcript after the paint that placed the reader. The observer runs
  // before that paint, so re-pinning here is a number changing, not a jump.
  useEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!el || !body) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) place();
    });
    observer.observe(body);
    observer.observe(el);
    return () => observer.disconnect();
  }, [place]);

  // Nearing the top asks for the page behind it. A hidden tab has no boxes to
  // intersect, so a background chat never fetches; the button stays for the
  // fetch that failed.
  useEffect(() => {
    const el = scroller.current;
    const mark = sentinel.current;
    if (!el || !mark || !more) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadEarlier();
      },
      { root: el, rootMargin: `${PREFETCH_PX}px 0px 0px 0px` },
    );
    observer.observe(mark);
    return () => observer.disconnect();
  }, [more, onLoadEarlier]);

  // Scrolled to once. The mark is the focus itself, so it survives until the
  // next hit — the animation fades it, and keeping it is what holds open the
  // phase the row lives in.
  const scrolled = useRef<string | null>(null);

  useEffect(() => {
    if (!focusId || scrolled.current === focusId) return;
    let frames = 0;
    let handle = 0;
    // The row may live in a folded phase that opens on this render and mounts
    // its panel on the next one, so this looks again for a few frames.
    const look = () => {
      const target = scroller.current?.querySelector(
        `[data-block="${focusId}"]`,
      );
      if (target) {
        scrolled.current = focusId;
        pinned.current = false;
        target.scrollIntoView({ block: "center" });
        return;
      }
      frames += 1;
      if (frames <= FOCUS_FRAMES) handle = window.requestAnimationFrame(look);
    };
    look();
    return () => window.cancelAnimationFrame(handle);
  }, [focusId]);

  return (
    <div
      ref={scroller}
      data-selectable="blocks"
      data-focus={focusId ?? ""}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div ref={content} className="crew-prose px-6 pt-5 pb-7">
        <div ref={sentinel} aria-hidden className="h-px" />
        {more && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              disabled={loadingEarlier}
              onClick={onLoadEarlier}
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
                  focusId={focusId}
                  marked={focusId}
                  onApprove={onApprove}
                  onAnswer={onAnswer}
                />
              </div>
            );
          }
          if (row.kind === "footer") {
            return (
              <div key={row.id} className={className}>
                <TurnFooter
                  usage={row.usage}
                  {...(row.at !== undefined ? { at: row.at } : {})}
                />
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
            <div
              key={block.id}
              data-block={block.id}
              className={`${className}${block.id === focusId ? " crew-found" : ""}`}
            >
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
          <div
            className={
              rows.length > 0
                ? speaker(rows.at(-1)!) === "agent"
                  ? "mt-1.5"
                  : "mt-5"
                : ""
            }
          >
            <ThinkingLine />
          </div>
        )}
      </div>
    </div>
  );
}
