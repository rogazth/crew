import clsx from "clsx";
import { memo, useEffect, useState } from "react";
import {
  FOLD_AT,
  activityDigest,
  buildActivity,
  clock,
  hasBody,
  isOpen,
  phaseFailed,
  phaseLabel,
  phaseOpen,
  summarize,
  toolLine,
  type ApprovalDecision,
  type Block,
  type Phase,
} from "@crew/fixtures";
import { Bars } from "@/ui";
import { PHASE_VERB, crewLineOf, verbOf } from "@/lib/format";
import { resolveAgent } from "@/lib/roster";
import { store } from "@/lib/store";
import { LogLine, LogRow } from "./LogRow";
import { ToolBody } from "./ToolBody";
import { ApprovalCard } from "./ApprovalCard";
import { AnsweredQuestion, QuestionCard } from "./QuestionCard";

export type ActivityProps = {
  blocks: Block[];
  live: boolean;
  /** The pin clears when the conversation moves past this group. */
  latest: boolean;
  hotRequestId: number | null;
  highlightId: string | null;
  onDecide: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Record<string, string> | null) => void;
};

export const Activity = memo(function Activity({
  blocks,
  live,
  latest,
  hotRequestId,
  highlightId,
  onDecide,
  onAnswer,
}: ActivityProps) {
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [bodies, setBodies] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!latest) setPinned(new Set());
  }, [latest]);

  const items = buildActivity(blocks);
  const needsAnswer = blocks.some(isOpen);
  const holdsHighlight = highlightId !== null && blocks.some((block) => block.id === highlightId);
  const digestKey = `digest-${blocks[0]?.id ?? "x"}`;
  const foldable = items.length >= FOLD_AT;
  const digestOpen =
    !foldable || live || needsAnswer || holdsHighlight || pinned.has(digestKey);

  const toggle = (key: string) =>
    setPinned((held) => {
      const next = new Set(held);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleBody = (id: string) =>
    setBodies((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const digest = activityDigest(items);
  const digestVerb = digest.kind === "thought" ? "···" : PHASE_VERB[digest.kind];

  if (!digestOpen) {
    const failed = items.some((item) => item.kind === "phase" && phaseFailed(item.phase));
    return (
      <LogRow gutter={digestVerb}>
        <FoldLine
          label={digest.label}
          open={false}
          failed={failed}
          count={blocks.length}
          onClick={() => toggle(digestKey)}
        />
      </LogRow>
    );
  }

  return (
    <div className="flex flex-col">
      {foldable ? (
        <LogRow gutter={digestVerb}>
          <FoldLine
            label={digest.label}
            open
            failed={false}
            count={blocks.length}
            onClick={() => toggle(digestKey)}
          />
        </LogRow>
      ) : null}

      <div
        className={clsx(foldable && "ml-[calc(var(--log-gutter)+13px)] border-l border-rule pl-2")}
      >
        {items.map((item) => {
          if (item.kind === "reasoning") {
            return (
              <ReasoningRow
                key={item.block.id}
                block={item.block}
                inset={foldable}
                highlighted={highlightId === item.block.id}
              />
            );
          }
          if (item.kind === "question") {
            const question = item.block.question;
            const settled = Boolean(question?.answers || question?.dismissed);
            return (
              <Line key={item.block.id} inset={foldable} gutter="ask" id={`block-${item.block.id}`}>
                {settled ? (
                  <AnsweredQuestion block={item.block} />
                ) : (
                  <QuestionCard
                    block={item.block}
                    hot={hotRequestId === question?.requestId}
                    onAnswer={(answers) => question && onAnswer(question.requestId, answers)}
                  />
                )}
              </Line>
            );
          }
          return (
            <PhaseRows
              key={item.phase.id}
              phase={item.phase}
              inset={foldable}
              pinned={pinned}
              bodies={bodies}
              highlightId={highlightId}
              hotRequestId={hotRequestId}
              onToggle={toggle}
              onToggleBody={toggleBody}
              onDecide={onDecide}
            />
          );
        })}
      </div>
    </div>
  );
});

function Line({
  inset,
  gutter,
  stamp,
  id,
  children,
}: {
  inset: boolean;
  gutter: string;
  stamp?: string;
  id?: string;
  children: React.ReactNode;
}) {
  if (inset) {
    return (
      <div id={id} className="flex items-start gap-2 py-px">
        <span className="w-[52px] shrink-0 pt-[1px] font-mono text-xs text-ink-4 select-none">
          {gutter}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    );
  }
  return (
    <LogRow gutter={gutter} {...(stamp ? { stamp } : {})} {...(id ? { id } : {})}>
      {children}
    </LogRow>
  );
}

function FoldLine({
  label,
  open,
  failed,
  count,
  onClick,
}: {
  label: string;
  open: boolean;
  failed: boolean;
  count: number;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-baseline gap-2 text-left">
      <span className="shrink-0 font-mono text-xs text-ink-4">{open ? "▾" : "▸"}</span>
      <span className={clsx("min-w-0 truncate text-md", failed ? "text-red-ink" : "text-ink-2")}>
        {label}
      </span>
      {failed ? (
        <span className="shrink-0 font-mono text-xs text-red-ink">failed</span>
      ) : null}
      <span className="ml-auto shrink-0 font-mono text-xs text-ink-4">{count}</span>
    </button>
  );
}

/**
 * A folded phase of Crew calls must still name what it did. `phaseLabel` sees
 * four `output` blobs and says "Ran 4 tools"; the two that matter are an agent
 * being created and a letter being sent, so those are what the line says.
 */
function labelForPhase(phase: Phase): string {
  const lines = phase.blocks.map((block) => crewLineOf(block, resolveAgent));
  const notable = lines.filter(
    (line) => line && (line.kind === "agent" || line.kind === "message" || line.kind === "routine"),
  );
  if (notable.length === 0 || notable.length === phase.blocks.length) return phaseLabel(phase);
  const [first, ...rest] = notable.map((line) => line!.text);
  if (!first) return phaseLabel(phase);
  return [first, ...rest.map((text) => text.charAt(0).toLowerCase() + text.slice(1))].join(", ");
}

/** A phase of Crew calls wears the verb of the loudest thing it did. */
function verbForPhase(phase: Phase): string {
  const lines = phase.blocks.map((block) => crewLineOf(block, resolveAgent));
  const notable = lines.find((line) => line?.kind === "agent") ?? lines.find((line) => line?.kind === "message");
  if (notable) return notable.kind === "agent" ? "agent" : "msg";
  return PHASE_VERB[phase.kind];
}

function PhaseRows({
  phase,
  inset,
  pinned,
  bodies,
  highlightId,
  hotRequestId,
  onToggle,
  onToggleBody,
  onDecide,
}: {
  phase: Phase;
  inset: boolean;
  pinned: Set<string>;
  bodies: Set<string>;
  highlightId: string | null;
  hotRequestId: number | null;
  onToggle: (key: string) => void;
  onToggleBody: (id: string) => void;
  onDecide: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const live = phaseOpen(phase);
  const failed = phaseFailed(phase);
  const holdsHighlight = highlightId !== null && phase.blocks.some((b) => b.id === highlightId);
  const foldable = phase.blocks.length > 1;
  const open = !foldable || live || holdsHighlight || pinned.has(phase.id);

  if (!open) {
    return (
      <Line inset={inset} gutter={verbForPhase(phase)}>
        <FoldLine
          label={labelForPhase(phase)}
          open={false}
          failed={failed}
          count={phase.blocks.length}
          onClick={() => onToggle(phase.id)}
        />
      </Line>
    );
  }

  return (
    <>
      {foldable ? (
        <Line inset={inset} gutter={verbForPhase(phase)}>
          <FoldLine
            label={labelForPhase(phase)}
            open
            failed={failed}
            count={phase.blocks.length}
            onClick={() => onToggle(phase.id)}
          />
        </Line>
      ) : null}
      <div className={clsx(foldable && "ml-1 border-l border-rule pl-2")}>
        {phase.blocks.map((block) => (
          <ToolRow
            key={block.id}
            block={block}
            inset={inset || foldable}
            bodyOpen={bodies.has(block.id)}
            highlighted={highlightId === block.id}
            hot={hotRequestId !== null && block.approval?.requestId === hotRequestId}
            onToggleBody={() => onToggleBody(block.id)}
            onDecide={onDecide}
          />
        ))}
      </div>
    </>
  );
}

function ToolRow({
  block,
  inset,
  bodyOpen,
  highlighted,
  hot,
  onToggleBody,
  onDecide,
}: {
  block: Block;
  inset: boolean;
  bodyOpen: boolean;
  highlighted: boolean;
  hot: boolean;
  onToggleBody: () => void;
  onDecide: (requestId: number, decision: ApprovalDecision) => void;
}) {
  const approval = block.approval;
  const pending = block.tool?.status === "pending";
  const interrupted = block.tool?.status === "interrupted";
  const line = toolLine(block, resolveAgent);
  const crew = crewLineOf(block, resolveAgent);
  const openable = hasBody(block) || Boolean(crew?.body);

  if (approval && !approval.decided) {
    return (
      <Line inset={inset} gutter="ask" id={`block-${block.id}`}>
        <ApprovalCard
          block={block}
          hot={hot}
          onDecide={(decision) => onDecide(approval.requestId, decision)}
        />
      </Line>
    );
  }

  const denied = approval?.decided === "deny";
  const peerId =
    crew?.peerId ??
    (crew?.peerName
      ? store.state.sessions.find((session) => session.name === crew.peerName)?.id
      : undefined);
  const suffix = pending ? (
    <Bars />
  ) : interrupted ? (
    "interrupted"
  ) : peerId && line.suffix ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        store.openSession(peerId);
      }}
      className="text-accent-ink hover:underline"
    >
      {line.suffix}
    </button>
  ) : (
    line.suffix
  );

  return (
    <Line
      inset={inset}
      gutter={verbOf(block, resolveAgent)}
      {...(block.at ? { stamp: clock(block.at) } : {})}
      id={`block-${block.id}`}
    >
      <div className={clsx(highlighted && "hl-flash rounded-[var(--r)]")}>
        <button
          type="button"
          disabled={!openable}
          onClick={onToggleBody}
          className={clsx("flex w-full text-left", openable ? "cursor-pointer" : "cursor-default")}
        >
          <LogLine
            text={line.text}
            {...(suffix ? { suffix } : {})}
            {...(line.failed ? { failed: true } : {})}
            {...(line.mono ? { mono: true } : {})}
            className={clsx(denied && "line-through opacity-60")}
            {...(openable ? { lead: <span className="font-mono text-xs text-ink-4">{bodyOpen ? "▾" : "▸"}</span> } : {})}
          />
        </button>
        {bodyOpen && openable ? <ToolBody block={block} /> : null}
      </div>
    </Line>
  );
}

function ReasoningRow({
  block,
  inset,
  highlighted,
}: {
  block: Block;
  inset: boolean;
  highlighted: boolean;
}) {
  const [open, setOpen] = useState(false);
  const streaming = Boolean(block.streaming);
  const shown = open || streaming;
  return (
    <Line inset={inset} gutter="···" id={`block-${block.id}`}>
      <div className={clsx(highlighted && "hl-flash rounded-[var(--r)]")}>
        <button
          type="button"
          onClick={() => setOpen((held) => !held)}
          className="flex w-full items-baseline gap-2 text-left"
        >
          <span className="shrink-0 font-mono text-xs text-ink-4">{shown ? "▾" : "▸"}</span>
          <span className="min-w-0 truncate text-md text-ink-3">
            {shown ? "Thought" : summarize(block.text)}
          </span>
        </button>
        {shown ? (
          <p className="mt-0.5 border-l border-rule pl-2 text-md whitespace-pre-wrap text-ink-3">
            {block.text}
          </p>
        ) : null}
      </div>
    </Line>
  );
}
