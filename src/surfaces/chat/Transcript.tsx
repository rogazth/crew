import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  awaitsUser,
  type Answers,
  type ApprovalDecision,
  type Block,
} from "../../lib/blocks";
import { turnStart, underway } from "../../lib/sessionChat";
import { foldTurns, groupRows, speaker, splitQueued } from "../../lib/transcriptRows";
import { WorkingLine } from "./Activity";
import { QueuedGroup } from "./Letters";
import { Rows } from "./Rows";
import { useBackgroundScope } from "./context";

const NEAR_BOTTOM_PX = 16;
/** How long a clicked row holds its place: the panel's 200ms, and room for what renders late in it. */
const ANCHOR_MS = 600;
/** How close to the top the reader gets before the page behind it is fetched. */
const PREFETCH_PX = 600;
/** How many frames to wait for a folded phase to mount the row it holds. */
const FOCUS_FRAMES = 20;
/** The step, down from the scroller's top edge, at which the row there is looked for. */
const PROBE_PX = 8;
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

/** A card the agent is stopped on: the time is the reader's, not the agent's. */
function waiting(blocks: Block[]): boolean {
  return blocks.some(awaitsUser);
}

/** Where the reader is: the first row on screen, and how far below the top edge it sits. */
type Reading = { row: Element; id: string; offset: number };

/** The row at the top of the scroller, probed down from its edge past the gaps between rows. */
function rowAtTop(el: HTMLElement): Reading | null {
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  for (let y = box.top + 1; y < box.bottom; y += PROBE_PX) {
    const row = document.elementFromPoint(x, y)?.closest("[data-block]");
    const id = row?.getAttribute("data-block");
    if (row && id && el.contains(row)) return { row, id, offset: row.getBoundingClientRect().top - box.top };
  }
  return null;
}

/** Stick-to-bottom scroller, with a 16px threshold. */
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
  /** The row the reader is on, which stays put whatever lands above or below it. */
  const reading = useRef<Reading | null>(null);
  /** Where the reader is, measured from the bottom: what holds them when the
   *  row they were on is gone. */
  const fromBottom = useRef(0);
  /** A row the reader just opened or closed: it stays where it was on screen while the panel moves. */
  const anchor = useRef<{ el: Element; top: number; until: number } | null>(null);
  // The queue at the foot waits under the working line, outside any turn.
  const { calls } = useBackgroundScope();
  const { rows, queued } = useMemo(() => {
    const split = splitQueued(groupRows(blocks, calls.size > 0 ? new Set(calls.keys()) : undefined));
    // The message the agent is already working on is that turn's prompt. It
    // sits above the working line; only what is still waiting stays queued.
    const prompt = underway(blocks, working);
    const queued = prompt ? split.queued.filter((block) => block.id !== prompt.id) : split.queued;
    const rows = prompt
      ? [...split.rows, { kind: "message" as const, block: { ...prompt, streaming: false } }]
      : split.rows;
    return { rows: foldTurns(rows, working), queued };
  }, [blocks, calls, working]);

  const onScroll = () => {
    const el = scroller.current;
    // Hidden, everything measures 0: that would read as pinned to the bottom.
    if (!el || el.clientHeight === 0) return;
    pinned.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    fromBottom.current = el.scrollHeight - el.scrollTop;
    reading.current = pinned.current ? null : rowAtTop(el);
  };

  const place = useCallback(() => {
    const el = scroller.current;
    // A tab behind another one is display:none, where every measurement reads
    // 0; writing one there is what lands the reader at the top of a year of
    // history the moment the tab is shown.
    if (!el || el.clientHeight === 0) return;
    const held = anchor.current;
    if (held && performance.now() < held.until && held.el.isConnected) {
      // What the reader clicked is the fixed point, not the bottom and not the
      // distance to it: the panel opens (or folds) under their pointer.
      el.scrollTop += held.el.getBoundingClientRect().top - held.top;
      fromBottom.current = el.scrollHeight - el.scrollTop;
      return;
    }
    anchor.current = null;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    // Reading something further up: messages arriving below, history loading
    // above, or a resync trimming it, must leave that row where it was. Behind
    // another tab nothing could hold it, so this is also what brings it back.
    const mark = reading.current;
    const row = mark && (mark.row.isConnected ? mark.row : el.querySelector(`[data-block="${CSS.escape(mark.id)}"]`));
    if (mark && row) {
      mark.row = row;
      const moved = row.getBoundingClientRect().top - el.getBoundingClientRect().top - mark.offset;
      // Not written when still: a write stops the wheel's momentum.
      if (Math.abs(moved) >= 1) el.scrollTop += moved;
      fromBottom.current = el.scrollHeight - el.scrollTop;
      return;
    }
    el.scrollTop = el.scrollHeight - fromBottom.current;
  }, []);

  // A click on anything that folds (a phase, a tool row, a letter) pins that
  // row for the length of the animation. Keyboard activation clicks too.
  const onClickCapture = (event: React.MouseEvent) => {
    const trigger = (event.target as Element).closest("[aria-expanded]");
    if (!trigger || !scroller.current?.contains(trigger)) return;
    anchor.current = { el: trigger, top: trigger.getBoundingClientRect().top, until: event.timeStamp + ANCHOR_MS };
    // Re-measured each frame of the panel's transition, which a resize observer
    // on the content also catches; this covers the frames it does not.
    const follow = () => {
      if (!anchor.current) return;
      place();
      if (anchor.current && performance.now() < anchor.current.until) requestAnimationFrame(follow);
      else {
        anchor.current = null;
        onScroll();
      }
    };
    requestAnimationFrame(follow);
  };

  useLayoutEffect(place, [place, blocks, working, active]);

  // Shiki answering, an image resolving, a webfont landing: each one grows the
  // transcript after the paint that placed the reader. The observer runs
  // before that paint, so re-placing here is a number changing, not a jump.
  useEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!el || !body) return;
    const observer = new ResizeObserver(place);
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
      onClickCapture={onClickCapture}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div ref={content} className="crew-prose mx-auto w-full max-w-[760px] px-6 pt-8 pb-10">
        <div ref={sentinel} aria-hidden className="h-px" />
        {more && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              disabled={loadingEarlier}
              onClick={onLoadEarlier}
              className="rounded-chrome px-2.5 py-1 text-[11px] text-icon transition-colors hover:bg-hover hover:text-text disabled:text-placeholder"
            >
              {loadingEarlier ? "Loading…" : "Earlier messages"}
            </button>
          </div>
        )}
        <Rows rows={rows} working={working} focusId={focusId} onApprove={onApprove} onAnswer={onAnswer} />
        {working && (
          <div className={rows.length > 0 ? (speaker(rows.at(-1)!) === "agent" ? "mt-2.5" : "mt-7") : ""}>
            <WorkingLine since={turnStart(blocks)} waiting={waiting(blocks)} />
          </div>
        )}
        {queued.length > 0 && (
          <div className={rows.length > 0 || working ? "mt-7" : ""}>
            <QueuedGroup blocks={queued} />
          </div>
        )}
      </div>
    </div>
  );
}

