import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon, CircleCheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Answers, ApprovalDecision } from "../../lib/blocks";
import { duration, dayLabel } from "../../lib/time";
import { gapBefore, rowBlocks, type Row } from "../../lib/transcriptRows";
import { ActivityGroup, SubagentRow } from "./Activity";
import { BackgroundMarker } from "./Background";
import { CheckpointRow, QueuedGroup, RefusedRow } from "./Letters";
import { AssistantMessage, DateBreak, Note, TurnFooter, UserMessage } from "./Message";

type Props = {
  rows: Row[];
  /** The agent is mid-turn: the last row is the work it is doing. */
  working: boolean;
  focusId: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
};

/** The transcript's rows, in order. A fold holds rows of its own and draws them the same way. */
export function Rows({ rows, working, focusId, onApprove, onAnswer }: Props) {
  return <>{rows.map((row, index) => {
    const className = gapBefore(rows[index - 1], row);
    switch (row.kind) {
      case "activity":
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
      case "fold":
        return (
          <div key={row.id} className={className}>
            <TurnFold row={row} focusId={focusId}>
              <Rows rows={row.rows} working={false} focusId={focusId} onApprove={onApprove} onAnswer={onAnswer} />
            </TurnFold>
          </div>
        );
      case "footer":
        return (
          <div key={row.id} className={className}>
            <TurnFooter
              usage={row.usage}
              {...(row.at !== undefined ? { at: row.at } : {})}
              {...(row.text !== undefined ? { text: row.text } : {})}
              {...(row.folded ? { folded: true } : {})}
            />
          </div>
        );
      case "date":
        return (
          <div key={row.id} className={className}>
            <DateBreak label={dayLabel(row.at)} />
          </div>
        );
      case "letter":
        return (
          <div key={row.block.id} data-block={row.block.id} className={className}>
            <CheckpointRow block={row.block} />
          </div>
        );
      case "refused":
        return (
          <div key={row.block.id} data-block={row.block.id} className={className}>
            <RefusedRow block={row.block} />
          </div>
        );
      case "background":
        return (
          <div key={row.block.id} data-block={row.block.id} className={className}>
            <BackgroundMarker block={row.block} />
          </div>
        );
      case "subagent":
        return (
          <div key={row.block.id} className={className}>
            <SubagentRow block={row.block} marked={focusId} />
          </div>
        );
      case "queued":
        return (
          <div key={row.id} className={className}>
            <QueuedGroup blocks={row.blocks} />
          </div>
        );
      case "message": {
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
      }
    }
  })}</>;
}

/**
 * A finished turn's work, behind the line that says how long it took. Opens
 * for a search hit inside it; otherwise it stays as the reader left it.
 */
export function TurnFold({
  row,
  focusId,
  children,
}: {
  row: Extract<Row, { kind: "fold" }>;
  focusId: string | null;
  children: ReactNode;
}) {
  const [pinned, setPinned] = useState<boolean | null>(null);
  const holds = focusId !== null && row.rows.some((inner) => rowBlocks(inner).some((block) => block.id === focusId));
  const open = pinned ?? holds;
  const label = row.durationMs !== undefined ? `Worked for ${duration(row.durationMs)}` : "Worked";
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="crew-node relative">
          <CircleCheckIcon className="size-3.5 transition-opacity group-hover:opacity-0" />
          <ChevronRightIcon
            className={`absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
          />
        </span>
        <span className="text-text-muted tabular-nums transition-colors group-hover:text-text">{label}</span>
        {row.failed ? <span className="shrink-0 text-[11px] text-danger">failed</span> : null}
        <span className="h-px flex-1 bg-hairline" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="pt-2.5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
