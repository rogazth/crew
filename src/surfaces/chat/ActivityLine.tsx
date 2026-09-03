import {
  ChatCircleDotsIcon,
  CircleNotchIcon,
  FileTextIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  RobotIcon,
  SparkleIcon,
  TerminalIcon,
  WrenchIcon,
  type Icon,
} from "@phosphor-icons/react";
import { createElement, memo, useState } from "react";
import { isOpen, type Answers, type ApprovalDecision, type Block } from "../../lib/blocks";
import { QuestionCard, answerSummary } from "./QuestionCard";

type Props = {
  blocks: Block[];
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

function glyphFor(name: string): Icon {
  const key = name.toLowerCase();
  if (key === "bash" || key.includes("shell") || key.includes("command")) return TerminalIcon;
  if (key === "read" || key === "notebookread") return FileTextIcon;
  if (key === "edit" || key === "multiedit" || key === "write" || key === "notebookedit") return PencilSimpleIcon;
  if (key === "glob" || key === "grep" || key.includes("search")) return MagnifyingGlassIcon;
  if (key.includes("web") || key.includes("fetch")) return GlobeIcon;
  if (key === "task" || key === "agent") return RobotIcon;
  return WrenchIcon;
}

function ToolGlyph({ block }: { block: Block }) {
  if (block.role === "reasoning") return <SparkleIcon className="size-3.5" />;
  if (block.role === "question") return <ChatCircleDotsIcon className="size-3.5" />;
  return createElement(glyphFor(block.tool?.name ?? block.approval?.name ?? ""), { className: "size-3.5" });
}

/** A muted log at sidebar density. Consecutive tools fold; three settled ones stay. */
export const ActivityGroup = memo(function ActivityGroup({ blocks, onApprove, onAnswer }: Props) {
  const [open, setOpen] = useState(false);
  const pending = blocks.filter(isOpen);
  const settled = blocks.filter((block) => !isOpen(block));
  const hidden = settled.length > 3 ? settled.slice(0, -3) : [];
  const visible = hidden.length > 0 && !open ? [...settled.slice(-3), ...pending] : blocks;

  return (
    <div className="flex flex-col gap-0.5">
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="ml-[22px] w-fit text-[12px] leading-4 text-text-muted transition-colors duration-100 hover:text-text"
        >
          {open ? "Hide earlier" : `${hidden.length} earlier`}
        </button>
      )}
      {visible.map((block) =>
        block.role === "question" && isOpen(block) ? (
          <QuestionCard key={block.id} block={block} onAnswer={onAnswer} />
        ) : (
          <ActivityLine key={block.id} block={block} onApprove={onApprove} />
        ),
      )}
    </div>
  );
});

function labelFor(block: Block): string {
  if (block.role === "reasoning") return block.streaming ? "Thinking" : "Thought";
  if (block.role === "question") {
    const summary = answerSummary(block);
    return summary ? `${block.text}: ${summary}` : block.text;
  }
  return block.tool?.title ?? block.text;
}

const ActivityLine = memo(function ActivityLine({
  block,
  onApprove,
}: {
  block: Block;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const pending = isOpen(block) || (block.role === "reasoning" && block.streaming === true);
  const failed = block.tool?.status === "failed";
  const skipped = block.approval?.decided === "deny" || block.question?.dismissed === true;
  const requestId = block.approval?.requestId;
  const undecided = block.role === "approval" && requestId != null && !block.approval?.decided;

  return (
    <div className="group flex min-h-5 items-center gap-2 text-[12px] leading-4">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-kumo-subtle">
        {pending ? (
          <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
        ) : (
          <ToolGlyph block={block} />
        )}
      </span>
      <span
        className={`min-w-0 truncate transition-colors duration-100 ${
          failed
            ? "text-danger"
            : skipped
              ? "text-placeholder line-through"
              : "text-text-muted group-hover:text-text"
        }`}
      >
        {labelFor(block)}
      </span>
      {undecided && requestId != null && (
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onApprove(requestId, "deny")}
            className="h-6 rounded-md bg-card px-2 text-[12px] leading-4 text-text transition-colors duration-100 hover:bg-hover focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onApprove(requestId, "always")}
            className="h-6 rounded-md bg-card px-2 text-[12px] leading-4 text-text transition-colors duration-100 hover:bg-hover focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none"
          >
            Always
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => onApprove(requestId, "allow")}
            className="crew-ink h-6 rounded-md px-2 text-[12px] leading-4 transition-colors duration-100 hover:bg-kumo-brand-hover focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none"
          >
            Allow
          </button>
        </span>
      )}
    </div>
  );
});

/** One activity-weight line for the gap between sending and the first token. */
export function ThinkingLine() {
  return (
    <div className="flex min-h-5 items-center gap-2 text-[12px] leading-4 text-text-muted">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <CircleNotchIcon className="size-3.5 animate-spin text-kumo-warning" weight="bold" />
      </span>
      <span className="animate-status-pulse">Thinking</span>
    </div>
  );
}
