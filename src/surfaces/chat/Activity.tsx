import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, FileTextIcon, GlobeIcon, LoaderCircleIcon, MessageCircleMoreIcon, PencilIcon, SearchIcon, SendIcon, SparkleIcon, TerminalIcon, WrenchIcon, XIcon, type LucideIcon as Icon } from "lucide-react";
import { createElement, memo, useMemo, useState, type ReactNode } from "react";
import {
  FOLD_AT,
  activityDigest,
  buildActivity,
  phaseFailed,
  phaseLabel,
  phaseOpen,
  summarize,
  type ActivityDigest,
  type Phase,
  type PhaseKind,
} from "../../lib/activity";
import { answerSummary, isOpen, type Answers, type ApprovalDecision, type Block } from "../../lib/blocks";
import { glyphKind, hasBody, toolLine } from "../../lib/toolDetail";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ToolBody } from "./ToolBody";

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
};

const KIND_ICON: Record<PhaseKind, Icon> = {
  edit: PencilIcon,
  research: SearchIcon,
  run: TerminalIcon,
  other: WrenchIcon,
};

const DIGEST_ICON: Record<ActivityDigest["kind"], Icon> = { ...KIND_ICON, thought: SparkleIcon };

/** A row wears what it did, not what its phase was called. */
const DETAIL_ICON: Record<string, Icon> = {
  command: TerminalIcon,
  file: FileTextIcon,
  edit: PencilIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  message: SendIcon,
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
    prev.onAnswer !== next.onAnswer
  ) {
    return false;
  }
  if (prev.blocks.length !== next.blocks.length) return false;
  return prev.blocks.every((block, index) => block === next.blocks[index]);
}

/** Tool calls fold into phases; a thought or a question is a row of its own. */
export const ActivityGroup = memo(function ActivityGroup({
  blocks,
  live,
  focusId,
  marked,
  onApprove,
  onAnswer,
}: Props) {
  const items = useMemo(() => buildActivity(blocks), [blocks]);
  // Keys go to one card: the newest thing waiting on the user.
  const hot = live ? blocks.filter(isOpen).at(-1)?.id : undefined;
  // Its own rail, unless a run folds it: then the run's steps are the rail.
  const folds = items.length >= FOLD_AT;
  const rows = (
    <div className={`flex flex-col gap-1.5 ${folds ? "" : "crew-timeline"}`}>
      {items.map((item, index) => {
        if (item.kind === "question") {
          return isOpen(item.block) ? (
            <QuestionCard key={item.block.id} block={item.block} hot={hot === item.block.id} onAnswer={onAnswer} />
          ) : (
            <AnsweredRow key={item.block.id} block={item.block} />
          );
        }
        if (item.kind === "reasoning") {
          return <ReasoningRow key={item.block.id} block={item.block} marked={marked} />;
        }
        return (
          <PhaseRow
            key={item.phase.id}
            phase={item.phase}
            live={live && index === items.length - 1}
            hot={hot}
            focusId={focusId}
            marked={marked}
            onApprove={onApprove}
          />
        );
      })}
    </div>
  );
  if (!folds) return rows;
  return (
    <div className="crew-timeline">
    <RunShell blocks={blocks} items={items} live={live} focusId={focusId} marked={marked}>
      {rows}
    </RunShell>
    </div>
  );
}, sameBlocks);

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
 * A long run of thinking and calls behind one line. Open while the agent is in
 * it, or while something in it needs an answer; folds when the turn moves on,
 * and a click pins it either way. Short runs never get here: three rows read
 * faster than a line you have to open.
 */
function RunShell({
  blocks,
  items,
  live,
  focusId,
  marked,
  children,
}: {
  blocks: Block[];
  items: ReturnType<typeof buildActivity>;
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
  const open = waiting || (pinned ?? (holds || live));
  const digest = useMemo(() => activityDigest(items), [items]);

  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="crew-node relative">
          {createElement(DIGEST_ICON[digest.kind], {
            className: `size-3.5 transition-opacity group-hover:opacity-0${failed ? " text-danger" : ""}`,
          })}
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span className={waiting ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}>
          {digest.label}
        </span>
        {/* A folded run hides its rows; a failure inside it may not hide too. */}
        {failed && !waiting ? <span className="shrink-0 text-[11px] text-danger">failed</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-phase-steps">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Open while the agent is in it or something in it needs an answer; folds
 * when the agent moves on. A click pins it either way.
 */
function PhaseRow({
  phase,
  live,
  hot,
  focusId,
  marked,
  onApprove,
}: {
  phase: Phase;
  live: boolean;
  hot: string | undefined;
  focusId: string | null;
  marked: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const waiting = phaseOpen(phase);
  const failed = phaseFailed(phase);
  // A row nobody can see is a row nobody can be sent to, and the mark outlives
  // the request, so the phase stays open after the reader has been taken there.
  const sent = (id: string | null) => id !== null && phase.blocks.some((block) => block.id === id);
  const holds = sent(focusId) || sent(marked);
  const [pinned, setPinned] = useFold(live);
  const open = waiting || (pinned ?? (holds || live));
  const single = phase.blocks.length === 1 && !waiting;

  if (single) {
    const block = phase.blocks[0]!;
    return (
      <ToolRow
        block={block}
        hot={hot}
        marked={marked}
        onApprove={onApprove}
        icon={iconFor(block, KIND_ICON[phase.kind])}
      />
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <PhaseLine phase={phase} waiting={waiting} failed={failed} open={open} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-phase-steps">
          {phase.blocks.map((block) => (
            <ToolRow key={block.id} block={block} hot={hot} marked={marked} onApprove={onApprove} />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** What a folded phase says: a glyph, its one line, and whether it went wrong. */
function PhaseLine({
  phase,
  waiting,
  failed,
  open,
}: {
  phase: Phase;
  waiting: boolean;
  failed: boolean;
  open: boolean;
}) {
  return (
    <>
      <span className="crew-node relative">
        {waiting ? (
          <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />
        ) : (
          <>
            {createElement(failed ? XIcon : KIND_ICON[phase.kind], {
              className: `size-3.5 transition-opacity group-hover:opacity-0${failed ? " text-danger" : ""}`,
            })}
            <ChevronRightIcon
              className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
            />
          </>
        )}
      </span>
      <span className={waiting ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}>
        {phaseLabel(phase)}
      </span>
      {/* A folded phase hides its rows; a failure inside it may not hide too. */}
      {failed && !waiting ? <span className="shrink-0 text-[11px] text-danger">failed</span> : null}
    </>
  );
}

const ROW = "group flex min-h-[26px] items-center gap-2 py-0.5 text-[13px] leading-[18px]";

/** The row a search hit sent the reader to. */
function lit(id: string, marked: string | null): string {
  return id === marked ? " crew-found" : "";
}

/** Spinner while it runs, cross when it failed, caret when it can open. */
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
  if (pending) return <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />;
  if (failed) return <XIcon className="size-3 text-danger" />;
  if (openable) {
    return (
      <ChevronRightIcon
        className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
      />
    );
  }
  return icon ? createElement(icon, { className: "size-3.5" }) : null;
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
      <span className="crew-node">
        <ToolGlyph pending={isOpen(block)} failed={failed} open={open} openable={openable} icon={icon} />
      </span>
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
  if (!hasBody(block)) {
    return (
      <div className={`${ROW}${lit(block.id, marked)}`} data-block={block.id}>
        <ToolLine block={block} open={false} openable={false} icon={icon} />
      </div>
    );
  }
  return (
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
}

/** Folded to its first line. Opens while streaming; never opened by the group around it. */
function ReasoningRow({ block, marked }: { block: Block; marked: string | null }) {
  const streaming = block.streaming === true;
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? streaming;
  const summary = summarize(block.text);
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger
        data-block={block.id}
        className={`group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]${lit(block.id, marked)}`}
      >
        <span className="crew-node relative">
          <SparkleIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span className={`min-w-0 truncate ${streaming ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}`}>
          {streaming ? "Thinking" : summary || "Thought"}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <p className="crew-phase-steps whitespace-pre-wrap py-0.5 text-[13px] leading-[18px] text-text-muted">{block.text}</p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function AnsweredRow({ block }: { block: Block }) {
  const summary = answerSummary(block);
  const dismissed = block.question?.dismissed === true;
  return (
    <div className="flex min-h-[26px] items-center gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="crew-node">
        <MessageCircleMoreIcon className="size-3.5" />
      </span>
      <span className={`min-w-0 truncate ${dismissed ? "text-placeholder line-through" : "text-text-muted"}`}>
        {block.text}
        {summary && !dismissed ? <span className="text-text">: {summary}</span> : null}
      </span>
    </div>
  );
}

/** One activity-weight line for the gap between sending and the first token. */
export function ThinkingLine() {
  return (
    <div className="flex min-h-[26px] items-center gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="crew-node">
        <LoaderCircleIcon className="size-3.5 animate-spin text-warning" />
      </span>
      <span className="crew-shimmer">Thinking</span>
    </div>
  );
}
