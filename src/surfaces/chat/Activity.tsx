import { Collapsible } from "@base-ui/react/collapsible";
import { BotIcon, ChevronRightIcon, FileTextIcon, GlobeIcon, ListChecksIcon, MessageCircleMoreIcon, NotebookTextIcon, PencilIcon, PlugIcon, SearchIcon, SendIcon, SparklesIcon, TerminalIcon, WrenchIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { createElement, lazy, memo, Suspense, useMemo, useState, type ReactNode } from "react";
import { TypingDots } from "../../chrome/StatusDot";
import {
  FOLD_AT,
  activityDigest,
  buildActivity,
  currentActivity,
  afterSummary,
  phaseKind,
  summarize,
  type ActivityDigest,
  type PhaseKind,
} from "../../lib/activity";
import { useNow } from "../../hooks/useNow";
import { duration } from "../../lib/time";
import { answerSummary, isOpen, type Answers, type ApprovalDecision, type Block } from "../../lib/blocks";
import { glyphKind, hasBody, toolLine, type ToolGlyphKind } from "../../lib/toolDetail";
import { ApprovalCard } from "./ApprovalCard";
import { AttachmentStrip } from "./Attachments";
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
  /** Never behind one line of its own: it already sits behind a subagent's. */
  flat?: boolean;
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
    prev.flat !== next.flat
  ) {
    return false;
  }
  if (prev.blocks.length !== next.blocks.length) return false;
  return prev.blocks.every((block, index) => block === next.blocks[index]);
}

/**
 * Every call, thought and question is a row of its own on one rail. A long run
 * hides behind one line that says what it was; a short one does not, and a
 * group inside a turn's fold never does: the fold already is that line.
 */
export const ActivityGroup = memo(function ActivityGroup({
  blocks,
  live,
  focusId,
  marked,
  onApprove,
  onAnswer,
  flat = false,
}: Props) {
  const steps = useMemo(() => blocks.filter(shown), [blocks]);
  // Keys go to one card: the newest thing waiting on the user.
  const hot = live ? blocks.filter(isOpen).at(-1)?.id : undefined;
  // Its own rail, unless a run folds it: then the run's steps are the rail.
  const folds = !flat && steps.length >= FOLD_AT;
  const rows = (
    <div className={`flex flex-col gap-0.5 ${folds ? "" : "crew-timeline"}`}>
      {steps.map((block) => (
        <StepRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} onAnswer={onAnswer} />
      ))}
    </div>
  );
  if (!folds) return rows;
  return (
    <div className="crew-timeline">
      <RunShell blocks={blocks} live={live} focusId={focusId} marked={marked}>
        {rows}
      </RunShell>
    </div>
  );
}, sameBlocks);

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

/**
 * Whether the reader has pinned this thing open or shut. Moving on clears the
 * pin, so the next turn's rows start folded again instead of inheriting a
 * decision made about work that is over.
 */
function useFold(live: boolean): [boolean | null, (next: boolean) => void] {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [wasLive, setWasLive] = useState(live);
  if (live !== wasLive) {
    setWasLive(live);
    if (!live) setPinned(null);
  }
  return [pinned, setPinned];
}

/**
 * A long run of thinking and calls behind one line. Folded from the start,
 * while the agent is still in it too: the line says what it has done and what
 * it is on now. It opens by itself only for something waiting on an answer or
 * a row the reader was sent to; a click pins it either way.
 */
function RunShell({
  blocks,
  live,
  focusId,
  marked,
  children,
}: {
  blocks: Block[];
  live: boolean;
  focusId: string | null;
  marked: string | null;
  children: ReactNode;
}) {
  const waiting = blocks.some(isOpen);
  const failed = blocks.some((block) => block.tool?.status === "failed");
  // A row nobody can see is a row nobody can be sent to, and the mark outlives
  // the request, so the run stays open after the reader has been taken there.
  const sent = (id: string | null) => id !== null && blocks.some((block) => block.id === id);
  const holds = sent(focusId) || sent(marked);
  const [pinned, setPinned] = useFold(live);
  const open = waiting || (pinned ?? holds);
  const digest = useMemo(() => activityDigest(buildActivity(blocks)), [blocks]);
  const now = live ? currentActivity(blocks) : null;

  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-6 w-full items-center gap-2 text-left text-[13px] leading-[18px]">
        <span className="crew-node relative">
          {createElement(failed ? XIcon : DIGEST_ICON[digest.kind], {
            className: `size-3.5 transition-opacity group-hover:opacity-0${failed ? " text-danger" : ""}`,
          })}
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span
          className={`shrink-0 ${live ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}`}
        >
          {digest.label}
        </span>
        {now && now !== digest.label ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-placeholder" title={now}>
            {now}
          </span>
        ) : null}
        {/* A folded run hides its rows; a failure inside it may not hide too. */}
        {failed && !waiting ? <span className="ml-auto shrink-0 text-[11px] text-danger">failed</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-phase-steps">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
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
 * at it, ticking. While a card waits on the reader the time is theirs, so the
 * line says so instead of counting.
 */
export function WorkingLine({ since, waiting }: { since: number | undefined; waiting: boolean }) {
  const now = useNow(1000, !waiting);
  const label = waiting ? "Waiting for you" : since !== undefined ? `Working for ${duration(Math.max(0, now - since))}` : "Working";
  return (
    <div className="flex min-h-6 items-center gap-2 text-[13px] leading-[18px]">
      <span className="crew-node">
        {waiting ? <MessageCircleMoreIcon className="size-3.5 text-warning" /> : <TypingDots />}
      </span>
      <span className={`tabular-nums ${waiting ? "text-text-muted" : "crew-shimmer"}`}>{label}</span>
    </div>
  );
}
