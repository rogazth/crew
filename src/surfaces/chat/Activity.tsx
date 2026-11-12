import { Collapsible } from "@base-ui/react/collapsible";
import { BotIcon, ChevronRightIcon, FileTextIcon, GlobeIcon, ListChecksIcon, MessageCircleMoreIcon, NotebookTextIcon, PencilIcon, PlugIcon, SearchIcon, SendIcon, SparklesIcon, TerminalIcon, WrenchIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { createElement, lazy, memo, Suspense, useMemo, useState } from "react";
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
import { isImage } from "../../lib/attachments";
import { allFailed, answerSummary, awaitsUser, isOpen, type Answers, type ApprovalDecision, type AttachedFile, type Block } from "../../lib/blocks";
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
    prev.since !== next.since
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
}: Props) {
  const steps = useMemo(() => blocks.filter(shown), [blocks]);
  const captures = useMemo(() => steps.flatMap((block) => (block.files ?? []).filter(isImage)), [steps]);
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
  const [viewing, setViewing] = useState<number | null>(null);
  if (steps.length === 0) return null;
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
      {!open && captures.length > 0 ? (
        <div className="crew-captures">
          {captures.map((file, index) => (
            <Capture key={file.path} file={file} onOpen={() => setViewing(index)} />
          ))}
        </div>
      ) : null}
      {!open && waiting.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {waiting.map((block) => (
            <StepRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} onAnswer={onAnswer} />
          ))}
        </div>
      ) : null}
      {viewing !== null ? (
        <Lightbox images={captures} index={Math.min(viewing, captures.length - 1)} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}, sameBlocks);

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
  const failed = allFailed(blocks);
  const doing = live && !waiting ? nowDoing(steps) : null;
  const icon: Icon = failed ? XIcon : DIGEST_ICON[digest.kind];
  return (
    <>
      <span className="crew-node relative">
        {doing ? (
          <WorkOrb state={orbFor(steps.at(-1))} label={doing} className="transition-opacity group-hover:opacity-0" />
        ) : (
          createElement(icon, { className: `size-3.5 transition-opacity group-hover:opacity-0${failed ? " text-danger" : ""}` })
        )}
        <ChevronRightIcon
          className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
        />
      </span>
      {doing ? (
        <span key={doing} className="crew-shimmer crew-line-in min-w-0 truncate" title={doing}>
          {doing}
        </span>
      ) : (
        <span className="min-w-0 truncate text-text-muted transition-colors group-hover:text-text">{digest.label}</span>
      )}
      {doing && since !== undefined ? (
        <span className="shrink-0 text-[11.5px] text-placeholder tabular-nums">{duration(Math.max(0, now - since))}</span>
      ) : null}
      {/* A folded run hides its rows; a failure inside it may not hide too. */}
      {failed && !live ? <span className="ml-auto shrink-0 text-[11px] text-danger">failed</span> : null}
    </>
  );
}

/** A capture the run took, small under its line; it opens in the viewer. */
function Capture({ file, onOpen }: { file: AttachedFile; onOpen: () => void }) {
  const src = useImageSrc(file.path);
  return (
    <button type="button" onClick={onOpen} title={file.name} aria-label={`Open ${file.name}`} className="crew-capture">
      {src ? <img src={src} alt={file.name} /> : null}
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
      <span className="crew-shimmer tabular-nums">{label}</span>
    </div>
  );
}
