import { Collapsible } from "@base-ui/react/collapsible";
import { BotIcon, ChevronRightIcon, FileTextIcon, GlobeIcon, ListChecksIcon, MessageCircleMoreIcon, NotebookTextIcon, PencilIcon, PlugIcon, SearchIcon, SendIcon, SparklesIcon, TerminalIcon, WrenchIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { createElement, lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { OrbState } from "thinking-orbs";
import { TypingDots } from "../../chrome/StatusDot";
import { WorkOrb } from "../../chrome/WorkOrb";
import {
  activityDigest,
  buildActivity,
  nowDoing,
  afterSummary,
  phaseKind,
  summarize,
  type ActivityDigest,
  type PhaseKind,
} from "../../lib/activity";
import { useNow } from "../../hooks/useNow";
import { duration } from "../../lib/time";
import { capturesOf } from "../../lib/attachments";
import { controlOf, isPeek } from "../../lib/orchestration";
import { ControlRow } from "./Orchestration";
import { answerSummary, awaitsUser, isOpen, type Answers, type ApprovalDecision, type AttachedFile, type Block } from "../../lib/blocks";
import { useImageSrc } from "../../hooks/useImageSrc";
import { glyphKind, hasBody, toolLine, type ToolGlyphKind } from "../../lib/toolDetail";
import { ApprovalCard } from "./ApprovalCard";
import { AttachmentStrip, Lightbox } from "./Attachments";
import { QuestionCard } from "./QuestionCard";
import { ToolBody } from "./ToolBody";

/** streamdown is half a megabyte: a thought loads it only once it is opened. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

type Props = {
  blocks: Block[];
  /** This group is the agent's current work; its last phase stays open. */
  live: boolean;
  /** A row the reader was sent to: the phase holding it has to open. */
  focusId: string | null;
  /** The row to light up, once the reader has been taken there. */
  marked: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
  /** When the turn began, for the live line's clock. */
  since?: number | undefined;
  /** Already behind a fold ("Worked for …"): its steps are listed, never folded a second time. */
  flat?: boolean | undefined;
};

const KIND_ICON: Record<PhaseKind, Icon> = {
  edit: PencilIcon,
  research: SearchIcon,
  run: TerminalIcon,
  other: WrenchIcon,
};

const DIGEST_ICON: Record<ActivityDigest["kind"], Icon> = { ...KIND_ICON, thought: SparklesIcon };

/** A row wears what it did, not what its phase was called. */
const DETAIL_ICON: Record<NonNullable<ToolGlyphKind>, Icon> = {
  command: TerminalIcon,
  file: FileTextIcon,
  edit: PencilIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  message: SendIcon,
  todo: ListChecksIcon,
  agent: BotIcon,
  mcp: PlugIcon,
  plan: NotebookTextIcon,
};

/** The orb that turns while the agent is on a step: what kind of work it is. */
const ORB: Record<NonNullable<ToolGlyphKind>, OrbState> = {
  command: "working",
  file: "searching",
  search: "searching",
  edit: "composing",
  fetch: "connecting",
  mcp: "connecting",
  message: "connecting",
  agent: "weaving",
  todo: "shaping",
  plan: "shaping",
};

function orbFor(block: Block | undefined): OrbState {
  if (!block) return "breathing";
  if (block.role === "reasoning") return "solving";
  const kind = glyphKind(block);
  return kind ? ORB[kind] : "working";
}

function iconFor(block: Block, fallback: Icon | undefined): Icon | undefined {
  const kind = glyphKind(block);
  return (kind && DETAIL_ICON[kind]) ?? fallback;
}

/**
 * The transcript regroups its rows every frame a turn streams, so `blocks` is a
 * fresh array holding the same blocks. Comparing it by element is what lets a
 * settled group sit out the turn instead of rebuilding its phases 60 times a second.
 */
function sameBlocks(prev: Props, next: Props): boolean {
  if (
    prev.live !== next.live ||
    prev.focusId !== next.focusId ||
    prev.marked !== next.marked ||
    prev.onApprove !== next.onApprove ||
    prev.onAnswer !== next.onAnswer ||
    prev.since !== next.since ||
    prev.flat !== next.flat
  ) {
    return false;
  }
  if (prev.blocks.length !== next.blocks.length) return false;
  return prev.blocks.every((block, index) => block === next.blocks[index]);
}

/**
 * The agent's work between two messages, as one line: what it is on while it
 * works, shimmering, and what it did once it is over. A click lays out every
 * call, thought and question on the rail below it. What it captured stays in
 * sight under the line, and what waits on the reader never hides behind it.
 */
export const ActivityGroup = memo(function ActivityGroup({
  blocks,
  live,
  focusId,
  marked,
  onApprove,
  onAnswer,
  since,
  flat = false,
}: Props) {
  const steps = useMemo(() => blocks.filter(shown), [blocks]);
  const captures = useMemo(() => capturesOf(steps), [steps]);
  const waiting = blocks.filter(awaitsUser);
  // Keys go to one card: the newest thing waiting on the user.
  const hot = live ? blocks.filter(isOpen).at(-1)?.id : undefined;
  // A row nobody can see is a row nobody can be sent to, and the mark outlives
  // the request, so the run stays open after the reader has been taken there.
  const sent = (id: string | null) => id !== null && blocks.some((block) => block.id === id);
  const [pinned, setPinned] = useState<boolean | null>(null);
  // Sent to a row inside, it opens even if the reader had closed it.
  const [sentTo, setSentTo] = useState(focusId);
  if (focusId !== sentTo) {
    setSentTo(focusId);
    if (sent(focusId)) setPinned(null);
  }
  const open = pinned ?? (sent(focusId) || sent(marked));
  if (steps.length === 0) return null;
  // One fold deep at most: the turn's fold already hides the work, so it opens onto the steps themselves.
  if (flat) {
    return (
      <div className="crew-timeline flex flex-col gap-0.5">
        {steps.map((block) => (
          <StepRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} onAnswer={onAnswer} />
        ))}
      </div>
    );
  }
  return (
    <div>
      <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
        <Collapsible.Trigger className="group flex min-h-6 w-full items-center gap-2 text-left text-[13px] leading-[18px]">
          <RunLine blocks={blocks} steps={steps} live={live} open={open} waiting={waiting.length > 0} since={since} />
        </Collapsible.Trigger>
        <Collapsible.Panel className="crew-phase-panel">
          <div className="crew-timeline flex flex-col gap-0.5 pt-1 pb-0.5">
            {steps.map((block) => (
              <StepRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} onAnswer={onAnswer} />
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
      {!open ? <Captures files={captures} enter={live} /> : null}
      {!open && waiting.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {waiting.map((block) => (
            <StepRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} onAnswer={onAnswer} />
          ))}
        </div>
      ) : null}
    </div>
  );
}, sameBlocks);

/** The images the work captured, small under its line while it is closed; each opens in the viewer. */
export function Captures({ files, flush = false, enter = false }: { files: AttachedFile[]; flush?: boolean; /** Captures arrive as the agent takes them: each new one eases in. */ enter?: boolean }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const fit = useFit(row, files.length > 0);
  if (files.length === 0) return null;
  // One row at most: what does not fit folds into its last tile, which counts the rest.
  const folded = files.length > fit;
  const shown = folded ? files.slice(0, Math.max(0, fit - 1)) : files;
  const rest = files.length - shown.length;
  return (
    <>
      <div ref={row} className={flush ? "crew-captures crew-captures-flush" : "crew-captures"}>
        {shown.map((file, index) => (
          <Capture key={file.path} file={file} enter={enter} onOpen={() => setViewing(index)} />
        ))}
        {folded ? <Capture key="more" file={files[shown.length]!} enter={enter} more={rest} onOpen={() => setViewing(shown.length)} /> : null}
      </div>
      {viewing !== null ? (
        <Lightbox images={files} index={Math.min(viewing, files.length - 1)} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}
    </>
  );
}

/** A capture tile's width and the gap between tiles, as `.crew-capture` and `.crew-captures` draw them. */
const CAPTURE_W = 72;
const CAPTURE_GAP = 6;

/** How many capture tiles fit on one line of the row, measured before it paints and again as it resizes. */
function useFit(row: React.RefObject<HTMLDivElement | null>, present: boolean): number {
  const [fit, setFit] = useState(Infinity);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setFit(Math.max(1, Math.floor((width + CAPTURE_GAP) / (CAPTURE_W + CAPTURE_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [row, present]);
  return fit;
}

/**
 * The run's one line. While the agent works it names the newest thing it is
 * on, each new one sliding in, and how long the turn has run; once it is over,
 * the two biggest kinds of work it did, muted.
 */
function RunLine({
  blocks,
  steps,
  live,
  open,
  waiting,
  since,
}: {
  blocks: Block[];
  steps: Block[];
  live: boolean;
  open: boolean;
  /** A card below waits on the reader: the time is theirs, so nothing turns or counts. The card says it waits; the line says what was done. */
  waiting: boolean;
  since: number | undefined;
}) {
  const now = useNow(1000, live && !waiting && since !== undefined);
  const digest = useMemo(() => activityDigest(buildActivity(blocks)), [blocks]);
  const doing = live && !waiting ? nowDoing(steps) : null;
  // A call that failed says so on its own row; the run's line says what was done.
  const icon: Icon = DIGEST_ICON[digest.kind];
  return (
    <>
      <span className="crew-node relative">
        {doing ? (
          <WorkOrb state={orbFor(steps.at(-1))} label={doing} className="transition-opacity group-hover:opacity-0" />
        ) : (
          createElement(icon, { className: "size-3.5 transition-opacity group-hover:opacity-0" })
        )}
        <ChevronRightIcon
          className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
        />
      </span>
      {doing ? (
        <RollingLine text={doing} />
      ) : (
        <span className="min-w-0 truncate text-text-muted transition-colors group-hover:text-text">{digest.label}</span>
      )}
      {doing && since !== undefined ? (
        <span className="shrink-0 text-[11.5px] text-placeholder tabular-nums">{duration(Math.max(0, now - since))}</span>
      ) : null}
    </>
  );
}

/** How long a sweep of the shimmer takes; `.crew-shimmer` in index.css runs on it. */
const SHIMMER_MS = 1600;

/**
 * Shimmering words. Every sweep runs on one clock, so words that replace
 * others pick up the light where it was instead of starting it over.
 */
function Shimmer({ children, className = "" }: { children: string; className?: string }) {
  const [phase] = useState<CSSProperties>(() => ({ animationDelay: `-${Math.round(performance.now() % SHIMMER_MS)}ms` }));
  return (
    <span className={`crew-shimmer ${className}`} style={phase}>
      {children}
    </span>
  );
}

/** How long a line rolls, and how long it stays before the next may push it out. */
const ROLL_MS = 320;
const HOLD_MS = 700;

/**
 * What the agent is on, as one line that rolls: the new one rises in as the
 * last rises out. A burst of steps settles on the newest instead of flickering
 * through each.
 */
function RollingLine({ text }: { text: string }) {
  const [frame, setFrame] = useState({ current: text, previous: null as string | null, seq: 0 });
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = performance.now();
  }, []);
  const current = frame.current;
  useEffect(() => {
    if (text === current) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const roll = () => {
      shownAt.current = performance.now();
      setFrame((f) => ({ current: text, previous: still ? null : f.current, seq: f.seq + 1 }));
    };
    const wait = still ? 0 : HOLD_MS - (performance.now() - shownAt.current);
    if (wait <= 0) return roll();
    const timer = window.setTimeout(roll, wait);
    return () => window.clearTimeout(timer);
  }, [text, current]);
  useEffect(() => {
    if (frame.previous === null) return;
    const seq = frame.seq;
    const timer = window.setTimeout(() => setFrame((f) => (f.seq === seq ? { ...f, previous: null } : f)), ROLL_MS);
    return () => window.clearTimeout(timer);
  }, [frame.seq, frame.previous]);
  // The outgoing line keeps its key, so its node and its light carry on as it leaves.
  return (
    <span className="crew-roll" title={frame.current}>
      {frame.previous !== null ? (
        <span key={frame.seq - 1} className="crew-roll-out" aria-hidden>
          <Shimmer className="truncate">{frame.previous}</Shimmer>
        </span>
      ) : null}
      <span key={frame.seq} className={frame.seq === 0 ? "crew-line-in" : "crew-roll-in"}>
        <Shimmer className="truncate">{frame.current}</Shimmer>
      </span>
    </span>
  );
}

/** A capture the run took, small under its line; it opens in the viewer. */
function Capture({ file, enter, more, onOpen }: { file: AttachedFile; enter: boolean; /** The tile stands for this many captures, itself among them: it shows the count over its picture. */ more?: number; onOpen: () => void }) {
  const src = useImageSrc(file.path);
  const label = more ? `${more} more captures` : `Open ${file.name}`;
  return (
    <button type="button" onClick={onOpen} title={more ? label : file.name} aria-label={label} className={enter ? "crew-capture crew-capture-in" : "crew-capture"}>
      {src ? <img src={src} alt="" /> : null}
      {more ? <span className="crew-capture-more">+{more}</span> : null}
    </button>
  );
}

/** A redacted thought arrives with no words: there is nothing to show for it. */
function shown(block: Block): boolean {
  return block.role !== "reasoning" || block.streaming === true || block.text.trim().length > 0;
}

/** One step of the run, drawn as what it is. */
function StepRow({
  block,
  hot,
  marked,
  onApprove,
  onAnswer,
}: {
  block: Block;
  hot: string | undefined;
  marked: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
}) {
  if (block.role === "question") {
    return isOpen(block) ? (
      <QuestionCard block={block} hot={hot === block.id} onAnswer={onAnswer} />
    ) : (
      <AnsweredRow block={block} />
    );
  }
  if (block.role === "reasoning") return <ReasoningRow block={block} marked={marked} />;
  // A Crew call that only looked reads as the sentence it is: whom it read, how many it listed.
  if (isPeek(block) && controlOf(block)) return <ControlRow block={block} marked={marked} />;
  return (
    <ToolRow
      block={block}
      hot={hot}
      marked={marked}
      onApprove={onApprove}
      icon={iconFor(block, KIND_ICON[phaseKind(block)])}
    />
  );
}

const ROW = "group flex min-h-6 items-center gap-2 text-[13px] leading-[18px]";

/** The row a search hit sent the reader to. */
function lit(id: string, marked: string | null): string {
  return id === marked ? " crew-found" : "";
}

/** Dots while it runs, cross when it failed; what it did otherwise, a caret on hover when it can open. */
function ToolGlyph({
  pending,
  failed,
  open,
  openable,
  icon,
}: {
  pending: boolean;
  failed: boolean;
  open: boolean;
  openable: boolean;
  icon?: Icon | undefined;
}) {
  if (pending) return <TypingDots />;
  if (failed) return <XIcon className="size-3 text-danger" />;
  const caret = (
    <ChevronRightIcon
      className={`size-3 transition-[opacity,transform] duration-150 ${open ? "rotate-90" : ""}${icon ? " absolute opacity-0 group-hover:opacity-100" : ""}`}
    />
  );
  if (!icon) return openable ? caret : null;
  return (
    <>
      {createElement(icon, { className: `size-3.5${openable ? " transition-opacity group-hover:opacity-0" : ""}` })}
      {openable ? caret : null}
    </>
  );
}

function toneOf(failed: boolean, denied: boolean): string {
  if (failed) return "text-danger";
  if (denied) return "text-placeholder line-through";
  return "text-text-muted group-hover:text-text";
}

/** The one line a tool row shows folded, identical inside and outside a trigger. */
function ToolLine({
  block,
  open,
  openable,
  icon,
}: {
  block: Block;
  open: boolean;
  openable: boolean;
  icon?: Icon | undefined;
}) {
  const line = toolLine(block);
  const failed = line.failed === true;
  const tone = toneOf(failed, block.approval?.decided === "deny");
  return (
    <>
      <span className="crew-node relative">
        <ToolGlyph pending={isOpen(block)} failed={failed} open={open} openable={openable} icon={icon} />
      </span>
      {line.verb ? <span className={`shrink-0 transition-colors ${tone}`}>{line.verb}</span> : null}
      <span className={`min-w-0 truncate transition-colors ${tone} ${line.mono ? "font-mono text-[12.5px]" : ""}`}>
        {line.text}
      </span>
      {line.suffix ? (
        <span className={`shrink-0 text-[11px] ${failed ? "text-danger" : "text-placeholder"}`}>{line.suffix}</span>
      ) : null}
    </>
  );
}

function ToolRow({
  block,
  hot,
  marked,
  onApprove,
  icon,
}: {
  block: Block;
  hot: string | undefined;
  marked: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  /** Standalone rows carry the kind glyph; inside a phase the rail is the bullet. */
  icon?: Icon | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (block.role === "approval" && isOpen(block)) {
    return <ApprovalCard block={block} hot={hot === block.id} onApprove={onApprove} />;
  }
  const row = !hasBody(block) ? (
    <div className={`${ROW}${lit(block.id, marked)}`} data-block={block.id}>
      <ToolLine block={block} open={false} openable={false} icon={icon} />
    </div>
  ) : (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className={`${ROW} w-full text-left${lit(block.id, marked)}`} data-block={block.id}>
        <ToolLine block={block} open={open} openable icon={icon} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-tool-body">
          <ToolBody block={block} />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
  // A screenshot is what the call was for: it shows with the row shut.
  if (!block.files?.length) return row;
  return (
    <div>
      {row}
      <div className="crew-tool-files">
        <AttachmentStrip files={block.files} />
      </div>
    </div>
  );
}

/**
 * A thought, folded to its first line, which reads as it comes in. The rest
 * is a click away, streaming or not: watching words arrive is not the work.
 */
function ReasoningRow({ block, marked }: { block: Block; marked: string | null }) {
  const streaming = block.streaming === true;
  const [open, setOpen] = useState(false);
  // Found by a search, the rest of the thought is where the match may be.
  const [seen, setSeen] = useState(marked);
  if (marked !== seen) {
    setSeen(marked);
    if (marked === block.id) setOpen(true);
  }
  const summary = summarize(block.text);
  const rest = afterSummary(block.text);
  const label = (
    <span className={`min-w-0 truncate ${streaming ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}`}>
      {summary || (streaming ? "Thinking" : "Thought")}
    </span>
  );
  // A one-line thought is all in its row; there is nothing to open.
  if (!rest) {
    return (
      <div data-block={block.id} className={`${ROW}${lit(block.id, marked)}`}>
        <span className="crew-node">
          <SparklesIcon className="size-3.5" />
        </span>
        {label}
      </div>
    );
  }
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger
        data-block={block.id}
        className={`group flex min-h-6 w-full items-center gap-2 text-left text-[13px] leading-[18px]${lit(block.id, marked)}`}
      >
        <span className="crew-node relative">
          <SparklesIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        {label}
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-tool-body py-0.5 text-[13px] leading-[19px] text-text-muted">
          <Suspense fallback={<p className="whitespace-pre-wrap">{rest}</p>}>
            <Markdown text={rest} streaming={streaming} />
          </Suspense>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function AnsweredRow({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  const summary = answerSummary(block);
  const ask = block.question;
  const dismissed = ask?.dismissed === true;
  const label = (
    <span className={`min-w-0 truncate ${dismissed ? "text-placeholder line-through" : "text-text-muted"}`}>
      {block.text}
      {summary && !dismissed ? <span className="text-text">: {summary}</span> : null}
    </span>
  );
  // What was asked and what went back, each pair whole: the row only has room for the answers.
  const pairs = dismissed ? [] : (ask?.questions ?? []).map((q) => ({ q: q.question, a: ask?.answers?.[q.question] ?? "" }));
  if (pairs.length === 0) {
    return (
      <div className={ROW}>
        <span className="crew-node">
          <MessageCircleMoreIcon className="size-3.5" />
        </span>
        {label}
      </div>
    );
  }
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className={`${ROW} w-full text-left`}>
        <span className="crew-node relative">
          <MessageCircleMoreIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        {label}
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <dl className="crew-tool-body flex flex-col gap-2 py-1 text-[13px] leading-[19px]">
          {pairs.map(({ q, a }) => (
            <div key={q} className="flex flex-col">
              <dt className="text-text-muted">{q}</dt>
              <dd className={a ? "text-text" : "text-placeholder"}>{a || "No answer"}</dd>
            </div>
          ))}
        </dl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * The turn in progress, at the foot of the chat: how long the agent has been
 * at it, ticking. While a card waits on the reader it is not drawn: the card
 * already says the agent is stopped on them.
 */
export function WorkingLine({ since }: { since: number | undefined }) {
  const now = useNow(1000);
  const label = since !== undefined ? `Working for ${duration(Math.max(0, now - since))}` : "Working";
  return (
    <div className="flex min-h-6 items-center gap-2 text-[13px] leading-[18px]">
      <span className="crew-node">
        <WorkOrb state="breathing" label="Working" />
      </span>
      <Shimmer className="tabular-nums">{label}</Shimmer>
    </div>
  );
}
