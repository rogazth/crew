import { Collapsible } from "@cloudflare/kumo";
import {
  CaretRightIcon,
  ChatCircleDotsIcon,
  CircleNotchIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SparkleIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type Icon,
} from "@phosphor-icons/react";
import { createElement, memo, useEffect, useMemo, useState } from "react";
import { buildActivity, phaseLabel, phaseOpen, summarize, type Phase, type PhaseKind } from "../../lib/activity";
import { isOpen, type Answers, type ApprovalDecision, type Block } from "../../lib/blocks";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard, answerSummary } from "./QuestionCard";

type Props = {
  blocks: Block[];
  /** This group is the agent's current work; its last phase stays open. */
  live: boolean;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

const KIND_ICON: Record<PhaseKind, Icon> = {
  edit: PencilSimpleIcon,
  research: MagnifyingGlassIcon,
  run: TerminalIcon,
  other: WrenchIcon,
};

/**
 * The transcript regroups its rows every frame a turn streams, so `blocks` is a
 * fresh array holding the same blocks. Comparing it by element is what lets a
 * settled group sit out the turn instead of rebuilding its phases 60 times a second.
 */
function sameBlocks(prev: Props, next: Props): boolean {
  if (prev.live !== next.live || prev.onApprove !== next.onApprove || prev.onAnswer !== next.onAnswer) {
    return false;
  }
  if (prev.blocks.length !== next.blocks.length) return false;
  return prev.blocks.every((block, index) => block === next.blocks[index]);
}

/** Tool calls fold into phases; a thought or a question is a row of its own. */
export const ActivityGroup = memo(function ActivityGroup({ blocks, live, onApprove, onAnswer }: Props) {
  const items = useMemo(() => buildActivity(blocks), [blocks]);
  // Keys go to one card: the newest thing waiting on the user.
  const hot = live ? blocks.filter(isOpen).at(-1)?.id : undefined;
  return (
    <div className="flex flex-col">
      {items.map((item, index) => {
        if (item.kind === "question") {
          return isOpen(item.block) ? (
            <QuestionCard key={item.block.id} block={item.block} hot={hot === item.block.id} onAnswer={onAnswer} />
          ) : (
            <AnsweredRow key={item.block.id} block={item.block} />
          );
        }
        if (item.kind === "reasoning") return <ReasoningRow key={item.block.id} block={item.block} />;
        return (
          <PhaseRow
            key={item.phase.id}
            phase={item.phase}
            live={live && index === items.length - 1}
            hot={hot}
            onApprove={onApprove}
          />
        );
      })}
    </div>
  );
}, sameBlocks);

/**
 * Open while the agent is in it or something in it needs an answer; folds
 * when the agent moves on. A click pins it either way.
 */
function PhaseRow({
  phase,
  live,
  hot,
  onApprove,
}: {
  phase: Phase;
  live: boolean;
  hot: string | undefined;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const waiting = phaseOpen(phase);
  const [pinned, setPinned] = useState<boolean | null>(null);
  // Moving on clears the pin so the next turn's phases start folded again.
  useEffect(() => {
    if (!live) setPinned(null);
  }, [live]);
  const open = waiting || (pinned ?? live);
  const label = phaseLabel(phase);
  const single = phase.blocks.length === 1 && !waiting;

  if (single) {
    return <ToolRow block={phase.blocks[0]!} hot={hot} onApprove={onApprove} icon={KIND_ICON[phase.kind]} />;
  }

  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-5 w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
          {waiting ? (
            <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
          ) : (
            <>
              {createElement(KIND_ICON[phase.kind], { className: "size-3.5 transition-opacity group-hover:opacity-0" })}
              <CaretRightIcon
                weight="bold"
                className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
              />
            </>
          )}
        </span>
        <span className={waiting ? "crew-shimmer" : "text-text-muted transition-colors group-hover:text-text"}>
          {label}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="crew-phase-steps">
          {phase.blocks.map((block) => (
            <ToolRow key={block.id} block={block} hot={hot} onApprove={onApprove} />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ToolRow({
  block,
  hot,
  onApprove,
  icon,
}: {
  block: Block;
  hot: string | undefined;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  /** Standalone rows carry the kind glyph; inside a phase the rail is the bullet. */
  icon?: Icon;
}) {
  const pending = isOpen(block);
  const failed = block.tool?.status === "failed";
  const denied = block.approval?.decided === "deny";
  if (block.role === "approval" && pending) {
    return <ApprovalCard block={block} hot={hot === block.id} onApprove={onApprove} />;
  }

  return (
    <div className="group flex min-h-5 items-center gap-2 py-0.5 text-[13px] leading-[18px]">
      {(icon || pending || failed) && (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
          {pending ? (
            <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
          ) : failed ? (
            <XIcon className="size-3 text-danger" weight="bold" />
          ) : icon ? (
            createElement(icon, { className: "size-3.5" })
          ) : null}
        </span>
      )}
      <span
        className={`min-w-0 truncate ${
          failed ? "text-danger" : denied ? "text-placeholder line-through" : "text-text-muted group-hover:text-text"
        } transition-colors`}
      >
        {block.tool?.title ?? block.text}
      </span>
    </div>
  );
}

/** Folded to its first line. Opens while streaming; never opened by the group around it. */
function ReasoningRow({ block }: { block: Block }) {
  const streaming = block.streaming === true;
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? streaming;
  const summary = summarize(block.text);
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-5 w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="relative flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
          <SparkleIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <CaretRightIcon
            weight="bold"
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
    <div className="flex min-h-5 items-center gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
        <ChatCircleDotsIcon className="size-3.5" />
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
    <div className="flex min-h-5 items-center gap-2 py-0.5 text-[13px] leading-[18px]">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
      </span>
      <span className="crew-shimmer">Thinking</span>
    </div>
  );
}
