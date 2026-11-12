import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { Answers, ApprovalDecision } from "../../lib/blocks";
import { duration, dayName } from "../../lib/time";
import { gapBefore, reportAfter, rowBlocks, type Row } from "../../lib/transcriptRows";
import { ActivityGroup, Captures } from "./Activity";
import { capturesOf } from "../../lib/attachments";
import { BackgroundMarker } from "./Background";
import { QueuedGroup, RefusedRow } from "./Letters";
import { AgentAnswer, AskedOrSaid, ControlRow, LetterRow, ReportLetter, StartedRow, SubagentCall, SubagentReport, WaitedReport } from "./Orchestration";
import { AssistantMessage, DateBreak, SharedFiles, SystemLine, TurnFooter } from "./Message";
import { SIGNED_IN_NOTE } from "../../lib/auth";
import { agentDetail } from "../../lib/subagent";
import { waitedReport } from "../../lib/orchestration";
import { SettledCard } from "./SettledCard";

type Props = {
  rows: Row[];
  /** The agent is mid-turn: the last row is the work it is doing. */
  working: boolean;
  focusId: string | null;
  onApprove: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Answers | null) => void;
  /** When the running turn began, for the clock on its live line. */
  since?: number | undefined;
  /** Drawn inside a turn's fold: runs list their steps instead of folding them again. */
  inFold?: boolean | undefined;
};

/** A login's note stands later in the rows: the sign-in prompt at `index` is answered. */
function signedAfter(rows: Row[], index: number): boolean {
  return rows.slice(index + 1).some((row) => row.kind === "message" && row.block.role === "system" && row.block.text === SIGNED_IN_NOTE);
}

/** The transcript's rows, in order. A fold holds rows of its own and draws them the same way. */
export function Rows({ rows, working, focusId, onApprove, onAnswer, since, inFold = false }: Props) {
  return <>{rows.map((row, index) => {
    const className = gapBefore(rows[index - 1], row);
    switch (row.kind) {
      case "activity":
        return (
          <div key={row.id} className={className} {...(row.blocks.length === 1 && row.blocks[0]!.letterId ? { "data-letter": row.blocks[0]!.letterId } : {})}>
            <ActivityGroup
              blocks={row.blocks}
              live={working && index === rows.length - 1}
              focusId={focusId}
              marked={focusId}
              onApprove={onApprove}
              onAnswer={onAnswer}
              since={working && index === rows.length - 1 ? since : undefined}
              flat={inFold}
            />
          </div>
        );
      case "fold":
        return (
          <div key={row.id} className={className}>
            <TurnFold row={row} focusId={focusId}>
              <Rows rows={row.rows} working={false} focusId={focusId} onApprove={onApprove} onAnswer={onAnswer} inFold />
            </TurnFold>
          </div>
        );
      case "footer":
        return (
          <div key={row.id} data-turn-footer className={className}>
            <TurnFooter
              {...(row.at !== undefined ? { at: row.at } : {})}
              {...(row.text !== undefined ? { text: row.text } : {})}
            />
          </div>
        );
      case "date":
        return (
          <div key={row.id} className={className}>
            <DateBreak label={dayName(row.at)} />
          </div>
        );
      case "letter":
        return (
          <div key={row.block.id} className={className}>
            <LetterRow block={row.block} marked={focusId} />
          </div>
        );
      case "control":
        return (
          <div key={row.block.id} className={className}>
            <ControlRow block={row.block} marked={focusId} />
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
            <SubagentCall block={row.block} marked={focusId} done={reportAfter(row, rows[index + 1])} />
          </div>
        );
      case "started":
        return (
          <div key={row.block.id} className={className}>
            <StartedRow block={row.block} marked={focusId} done={reportAfter(row, rows[index + 1])} />
          </div>
        );
      case "report":
        // Right after its agent's start, it is drawn in that start's beat.
        if (reportAfter(rows[index - 1], row)) return null;
        return (
          <div key={row.block.id} className={className}>
            {agentDetail(row.block) ? (
              <SubagentReport block={row.block} />
            ) : waitedReport(row.block) ? (
              <WaitedReport block={row.block} />
            ) : (
              <ReportLetter block={row.block} marked={focusId} />
            )}
          </div>
        );
      case "shared":
        return (
          <div key={row.block.id} data-block={row.block.id} className={className}>
            <SharedFiles block={row.block} />
          </div>
        );
      case "decision":
        return (
          <div key={row.block.id} className={className}>
            <SettledCard block={row.block} marked={focusId} />
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
            data-message={block.role}
            className={`${className}${block.id === focusId ? " crew-found" : ""}`}
          >
            {row.answer ? (
              <AgentAnswer block={block} report={row.answer === "report"} />
            ) : block.role === "user" ? (
              <AskedOrSaid block={block} />
            ) : block.role === "system" ? (
              <SystemLine block={block} signedIn={signedAfter(rows, index)} />
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
 * for a search hit inside it; otherwise it stays as the reader left it. What
 * the work captured stays in sight under the line, as under a run's.
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
  // Sent to a row inside, it opens even if the reader had closed it.
  const [sentTo, setSentTo] = useState(focusId);
  if (focusId !== sentTo) {
    setSentTo(focusId);
    if (holds) setPinned(null);
  }
  const open = pinned ?? holds;
  const captures = useMemo(() => capturesOf(row.rows.flatMap(rowBlocks)), [row.rows]);
  const label = row.durationMs !== undefined ? `Worked for ${duration(row.durationMs)}` : "Worked";
  return (
    <Collapsible.Root open={open} onOpenChange={(next) => setPinned(next)}>
      <Collapsible.Trigger className="group flex min-h-[26px] w-full items-center gap-1.5 py-0.5 text-left text-[13px] leading-[18px]">
        <span className="text-text-muted tabular-nums transition-colors group-hover:text-text">{label}</span>
        <ChevronRightIcon className={`size-3 text-icon opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 ${open ? "rotate-90 opacity-100" : ""}`} />
        <span className="h-px flex-1 bg-hairline" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="crew-phase-panel">
        <div className="pt-2.5">{children}</div>
      </Collapsible.Panel>
      {!open ? <Captures files={captures} flush /> : null}
    </Collapsible.Root>
  );
}
