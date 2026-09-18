import { memo, useEffect, useState } from "react";
import {
  FOLD_AT,
  activityDigest,
  buildActivity,
  clock,
  hasBody,
  isOpen,
  phaseFailed,
  phaseOpen,
  summarize,
  toolLine,
} from "@crew/fixtures";
import type { ActivityItem, Block, Phase } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/lib/icon";
import { glyphFor, isConsequential, phaseLabelOf } from "@/lib/chat";
import { useApp } from "@/lib/store";
import { Tooltip } from "@/ui";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ToolBody } from "./ToolBody";

export type ActivityProps = {
  blocks: Block[];
  sessionId: string;
  /** The last group in the transcript keeps its pin; earlier ones drop it. */
  isLast: boolean;
  focusId: string | null;
};

const PHASE_ICON: Record<string, IconName> = {
  edit: "edit",
  research: "search",
  run: "terminal",
  other: "wrench",
};

export const Activity = memo(function Activity({ blocks, sessionId, isLast, focusId }: ActivityProps) {
  const items = buildActivity(blocks);
  const [pinned, setPinned] = useState<boolean | null>(null);

  // A pin belongs to the turn you were reading; the next turn takes it back.
  useEffect(() => {
    if (!isLast) setPinned(null);
  }, [isLast]);

  const live = blocks.some(isOpen);
  const holdsFocus = focusId !== null && blocks.some((b) => b.id === focusId);
  const folds = items.length >= FOLD_AT;
  // Consequential rows open by default but stay collapsible: the reader may fold
  // them, the transcript may not fold them for her.
  const open = pinned ?? (live || holdsFocus || blocks.some(isConsequential));

  if (folds && !open) {
    const digest = activityDigest(items);
    const failed = blocks.some((b) => b.tool?.status === "failed");
    return (
      <FoldLine
        icon={digest.kind === "thought" ? "brain" : (PHASE_ICON[digest.kind] ?? "wrench")}
        label={digest.label}
        count={blocks.length}
        failed={failed}
        onClick={() => setPinned(true)}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {folds && (
        <FoldLine
          icon="chevronUp"
          label="Hide activity"
          dim
          onClick={() => setPinned(false)}
        />
      )}
      {items.map((item) => (
        <ActivityRow
          key={keyOf(item)}
          item={item}
          sessionId={sessionId}
          focusId={focusId}
        />
      ))}
    </div>
  );
});

const keyOf = (item: ActivityItem) =>
  item.kind === "phase" ? item.phase.id : item.block.id;

function ActivityRow({
  item,
  sessionId,
  focusId,
}: {
  item: ActivityItem;
  sessionId: string;
  focusId: string | null;
}) {
  if (item.kind === "reasoning") return <ReasoningRow block={item.block} focusId={focusId} />;
  if (item.kind === "question") return <QuestionCard block={item.block} sessionId={sessionId} />;
  return <PhaseRow phase={item.phase} sessionId={sessionId} focusId={focusId} />;
}

function PhaseRow({
  phase,
  sessionId,
  focusId,
}: {
  phase: Phase;
  sessionId: string;
  focusId: string | null;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const live = phaseOpen(phase);
  const holdsFocus = focusId !== null && phase.blocks.some((b) => b.id === focusId);
  const single = phase.blocks.length === 1;
  const open =
    single || (pinned ?? (live || holdsFocus || phase.blocks.some(isConsequential)));

  if (!open) {
    return (
      <FoldLine
        icon={PHASE_ICON[phase.kind] ?? "wrench"}
        label={phaseLabelOf(phase)}
        count={phase.blocks.length}
        failed={phaseFailed(phase)}
        onClick={() => setPinned(true)}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {!single && (
        <FoldLine
          icon="chevronUp"
          label={phaseLabelOf(phase)}
          dim
          onClick={() => setPinned(false)}
        />
      )}
      {phase.blocks.map((block) => (
        <ToolRow key={block.id} block={block} sessionId={sessionId} focusId={focusId} />
      ))}
    </div>
  );
}

function ToolRow({
  block,
  sessionId,
  focusId,
}: {
  block: Block;
  sessionId: string;
  focusId: string | null;
}) {
  const { sessions } = useApp();
  const resolve = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;
  const [open, setOpen] = useState(false);
  const focused = focusId === block.id;

  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);

  if (block.role === "approval" && block.approval && !block.approval.decided) {
    return <ApprovalCard block={block} sessionId={sessionId} />;
  }

  const line = toolLine(block, resolve);
  const glyph = glyphFor(block, resolve);
  const pending = block.tool?.status === "pending";
  const interrupted = block.tool?.status === "interrupted";
  const denied = block.approval?.decided === "deny";
  const canOpen = hasBody(block);

  return (
    <div data-block={block.id} className={cx("flex flex-col", focused && "ink-flash rounded-sm")}>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          "group flex h-[18px] min-w-0 items-center gap-1.5 rounded-sm pr-1 text-left",
          "transition-colors duration-[var(--dur-1)]",
          canOpen && "hover:bg-[var(--fill-quaternary)]",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <Icon
            name={glyph.icon}
            size={12}
            className={cx(
              line.failed ? "text-[var(--status-danger)]" : "text-icon-tertiary",
              pending && "text-[var(--status-attention)]",
            )}
          />
        </span>
        <span
          className={cx(
            "min-w-0 truncate text-small",
            line.mono && "font-mono text-[12px]",
            line.failed ? "text-[var(--status-danger)]" : "text-tertiary",
            denied && "line-through decoration-[var(--stroke-primary)]",
            pending && "text-secondary",
          )}
        >
          {line.text}
        </span>
        {line.suffix && (
          <span
            className={cx(
              "shrink-0 text-micro tnum",
              line.failed ? "text-[var(--status-danger)]" : "text-quaternary",
            )}
          >
            {line.suffix}
          </span>
        )}
        {pending && <span className="shrink-0 text-micro text-[var(--status-attention)]">running</span>}
        {interrupted && <span className="shrink-0 text-micro text-quaternary">interrupted</span>}
        {block.approval?.decided && (
          <span className="shrink-0 text-micro text-quaternary">
            {block.approval.decided === "deny" ? "denied" : "allowed"}
          </span>
        )}
        {canOpen && (
          <Icon
            name={open ? "chevronUp" : "chevronDown"}
            size={12}
            className="shrink-0 text-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </button>
      {open && canOpen && <ToolBody block={block} />}
    </div>
  );
}

function ReasoningRow({ block, focusId }: { block: Block; focusId: string | null }) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? (Boolean(block.streaming) || focusId === block.id);
  const head = summarize(block.text) || "Thought";

  return (
    <div data-block={block.id} className={cx("flex flex-col", focusId === block.id && "ink-flash rounded-sm")}>
      <button
        type="button"
        onClick={() => setPinned(!open)}
        className="group flex h-[18px] min-w-0 items-center gap-1.5 rounded-sm pr-1 text-left transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-quaternary)]"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <Icon name="brain" size={12} className="text-icon-tertiary" />
        </span>
        <span className="min-w-0 truncate text-small italic text-tertiary">
          {open ? "Thought" : head}
        </span>
        <Icon
          name={open ? "chevronUp" : "chevronDown"}
          size={12}
          className="shrink-0 text-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100"
        />
      </button>
      {open && (
        <p className="mb-1 mt-0.5 whitespace-pre-wrap border-l border-[var(--stroke-tertiary)] pl-2.5 text-small italic leading-[18px] text-tertiary">
          {block.text}
          {block.streaming && <span className="ink-caret" />}
        </p>
      )}
    </div>
  );
}

function FoldLine({
  icon,
  label,
  count,
  failed,
  dim,
  onClick,
}: {
  icon: IconName;
  label: string;
  count?: number;
  failed?: boolean;
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group flex h-[18px] min-w-0 items-center gap-1.5 rounded-sm pr-1 text-left",
        "transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-quaternary)]",
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <Icon name={icon} size={12} className={cx(dim ? "text-icon-tertiary" : "text-icon-tertiary")} />
      </span>
      <span className={cx("min-w-0 truncate text-small", dim ? "text-quaternary" : "text-tertiary")}>
        {label}
      </span>
      {count !== undefined && count > 1 && (
        <span className="shrink-0 text-micro text-quaternary tnum">{count}</span>
      )}
      {/* A failure inside a fold has to survive the fold. */}
      {failed && (
        <Tooltip content="Something in here failed">
          <span className="flex shrink-0 items-center gap-1 text-micro text-[var(--status-danger)]">
            <Icon name="warning" size={11} />
            failed
          </span>
        </Tooltip>
      )}
      {!dim && (
        <Icon
          name="chevronDown"
          size={12}
          className="shrink-0 text-icon-tertiary opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
}

export function ThinkingLine({ since }: { since: number }) {
  return (
    <div className="flex h-[18px] items-center gap-1.5">
      <span
        className="ink-dot"
        data-status="working"
        style={{ "--dot": "var(--status-attention)" } as React.CSSProperties}
      >
        <span className="ink-dot-halo" />
        <span className="ink-dot-core" />
      </span>
      <span className="text-small text-tertiary">Thinking</span>
      <span className="text-micro text-quaternary tnum">{clock(since)}</span>
    </div>
  );
}
