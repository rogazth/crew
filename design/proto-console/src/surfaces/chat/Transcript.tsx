import clsx from "clsx";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  clock,
  dayLabel,
  gapBefore,
  groupRows,
  isOpen,
  showThinking,
  type ApprovalDecision,
  type Block,
  type Row,
  type Session,
} from "@crew/fixtures";
import { store } from "@/lib/store";
import { bytes, shortModel, usageLine } from "@/lib/format";
import { segmentsOf } from "@/lib/mentions";
import { useEvent, useStickToBottom } from "@/lib/hooks";
import { LogColumn, LogRow } from "./LogRow";
import { Activity } from "./Activity";
import { AgentThread } from "./AgentThread";
import { Markdown } from "./Markdown";
import { StreamText, Thinking, splitStream } from "./Stream";
import { CopyButton } from "./Code";

export type TranscriptProps = {
  session: Session;
  blocks: Block[];
  working: boolean;
  onDecide: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Record<string, string> | null) => void;
};

/** How many rows a page of the log holds. Demo threads fit inside one. */
const PAGE = 120;

export function Transcript({ session, blocks, working, onDecide, onAnswer }: TranscriptProps) {
  const pending = store.state.pendingScroll;
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const { ref, atBottom, toBottom } = useStickToBottom([blocks, session.id]);

  const rows = useMemo(() => {
    // The header owns the attribution now, so the daemon's own "Created by X"
    // note would just say it twice. Its other notes stay.
    const shown = session.createdBy
      ? blocks.filter(
          (block) => !(block.role === "system" && /^created by /i.test(block.text.trim())),
        )
      : blocks;
    return groupRows(shown, { resolveAgent: (id) => store.session(id)?.name ?? id });
  }, [blocks, session.createdBy]);

  const hotRequestId = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i]!;
      if (!isOpen(block)) continue;
      if (block.approval) return block.approval.requestId;
      if (block.question) return block.question.requestId;
    }
    return null;
  }, [blocks]);

  const decide = useEvent(onDecide);
  const answer = useEvent(onAnswer);

  // A five-thousand-block transcript is five thousand rows the reader cannot
  // see. The log pages backwards instead, which is what "Earlier messages"
  // means in the real app anyway.
  const shown = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  const older = rows.length - shown.length;
  const anchor = useRef(0);

  useEffect(() => {
    setLimit(PAGE);
  }, [session.id]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || anchor.current === 0) return;
    // Prepending rows must not move the line the reader is on.
    node.scrollTop += node.scrollHeight - anchor.current;
    anchor.current = 0;
  }, [limit, ref]);

  const loadEarlier = useEvent(() => {
    if (older === 0) return;
    anchor.current = ref.current?.scrollHeight ?? 0;
    setLimit((held) => held + PAGE);
  });

  useEffect(() => {
    if (!pending || pending.sessionId !== session.id) return;
    setHighlightId(pending.blockId);
    store.clearPendingScroll();
    const timer = window.setTimeout(() => {
      const node = document.getElementById(`block-${pending.blockId}`);
      node?.scrollIntoView({ block: "center" });
    }, 60);
    const clear = window.setTimeout(() => setHighlightId(null), 2_200);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [pending, session.id]);

  const onScroll = () => {
    const node = ref.current;
    if (node && node.scrollTop < 600) loadEarlier();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Cmd+A belongs to the transcript, not the window.
    if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      const body = ref.current?.querySelector("[data-log]");
      if (!body) return;
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const thinking = showThinking(blocks, working);
  const lastActivityId = [...rows].reverse().find((row) => row.kind === "activity")?.id ?? null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={-1}
        className="scroll min-h-0 flex-1 px-4 py-4 outline-none"
      >
        <LogColumn>
          <div data-log>
            <EarlierHeader older={older} count={blocks.length} onLoad={loadEarlier} />
            {shown.map((row, index) => (
              <RowView
                key={rowKey(row)}
                row={row}
                gap={gapBefore(shown[index - 1], row)}
                session={session}
                latest={row.kind === "activity" && row.id === lastActivityId}
                hotRequestId={hotRequestId}
                highlightId={highlightId}
                onDecide={decide}
                onAnswer={answer}
              />
            ))}
            {thinking ? (
              <LogRow gutter={shortModel(session.provider, session.model)} gap={20}>
                <Thinking />
              </LogRow>
            ) : null}
          </div>
        </LogColumn>
      </div>
      {!atBottom ? (
        <button
          type="button"
          onClick={toBottom}
          className="float absolute right-4 bottom-3 px-2 py-1 font-mono text-xs text-ink-2"
        >
          ↓ latest
        </button>
      ) : null}
    </div>
  );
}

function rowKey(row: Row): string {
  return `${row.kind}-${row.kind === "message" ? row.block.id : row.id}`;
}

function EarlierHeader({
  older,
  count,
  onLoad,
}: {
  older: number;
  count: number;
  onLoad: () => void;
}) {
  if (count === 0) return null;
  if (older === 0) {
    return <div className="grouprule mb-4 px-2 text-ink-4">{`beginning · ${count} blocks`}</div>;
  }
  return (
    <button type="button" onClick={onLoad} className="grouprule mb-4 w-full px-2 text-left hover:text-ink-2">
      earlier messages · {older.toLocaleString()} more
    </button>
  );
}

type RowViewProps = {
  row: Row;
  gap: number;
  session: Session;
  latest: boolean;
  hotRequestId: number | null;
  highlightId: string | null;
  onDecide: (requestId: number, decision: ApprovalDecision) => void;
  onAnswer: (requestId: number, answers: Record<string, string> | null) => void;
};

const RowView = memo(function RowView({
  row,
  gap,
  session,
  latest,
  hotRequestId,
  highlightId,
  onDecide,
  onAnswer,
}: RowViewProps) {
  if (row.kind === "date") {
    return (
      <LogRow gap={gap} contentClassName="pr-2">
        <div className="grouprule">{dayLabel(row.at)}</div>
      </LogRow>
    );
  }

  if (row.kind === "footer") {
    return (
      <LogRow gap={gap} {...(row.at ? { stamp: clock(row.at) } : {})}>
        <span className="font-mono text-xs text-ink-4">{usageLine(row.usage)}</span>
      </LogRow>
    );
  }

  if (row.kind === "activity") {
    return (
      <div style={gap ? { marginTop: gap } : undefined}>
        <Activity
          blocks={row.blocks}
          live={row.blocks.some(isOpen)}
          latest={latest}
          hotRequestId={hotRequestId}
          highlightId={highlightId}
          onDecide={onDecide}
          onAnswer={onAnswer}
        />
      </div>
    );
  }

  if (row.kind === "agent-thread") {
    return (
      <div style={gap ? { marginTop: gap } : undefined}>
        <AgentThread row={row} sessionId={session.id} me={session.name} />
      </div>
    );
  }

  return <MessageRow block={row.block} gap={gap} session={session} highlightId={highlightId} />;
}, sameRow);

const sameBlocks = (a: Block[], b: Block[]) =>
  a.length === b.length && a.every((block, index) => block === b[index]);

/**
 * `groupRows` allocates fresh row objects on every delta, but the blocks inside
 * them keep their identity — the reducer only replaces what changed. Comparing
 * the contents is what keeps a settled row from re-rendering 45 times a second.
 */
function sameRow(a: RowViewProps, b: RowViewProps): boolean {
  if (
    a.gap !== b.gap ||
    a.latest !== b.latest ||
    a.hotRequestId !== b.hotRequestId ||
    a.highlightId !== b.highlightId ||
    a.session !== b.session
  ) {
    return false;
  }
  const x = a.row;
  const y = b.row;
  if (x === y) return true;
  if (x.kind !== y.kind) return false;
  if (x.kind === "message" && y.kind === "message") return x.block === y.block;
  if (x.kind === "activity" && y.kind === "activity") return sameBlocks(x.blocks, y.blocks);
  if (x.kind === "agent-thread" && y.kind === "agent-thread") {
    return sameBlocks(
      x.messages.map((m) => m.block),
      y.messages.map((m) => m.block),
    );
  }
  if (x.kind === "footer" && y.kind === "footer") return x.id === y.id && x.usage === y.usage;
  if (x.kind === "date" && y.kind === "date") return x.at === y.at;
  return false;
}

function MessageRow({
  block,
  gap,
  session,
  highlightId,
}: {
  block: Block;
  gap: number;
  session: Session;
  highlightId: string | null;
}) {
  const highlighted = highlightId === block.id;

  if (block.role === "system") {
    return (
      <LogRow gutter="note" gap={gap} id={`block-${block.id}`}>
        <span className={clsx("text-md text-ink-4", highlighted && "hl-flash")}>{block.text}</span>
      </LogRow>
    );
  }

  if (block.role === "user") {
    return (
      <LogRow
        gutter={block.fromAgent ? block.fromAgent.name.toLowerCase() : "you"}
        stamp={block.at ? clock(block.at) : undefined}
        action={<CopyButton text={block.text} />}
        gap={gap}
        id={`block-${block.id}`}
      >
        <div className={clsx("group/msg", highlighted && "hl-flash rounded-[var(--r)]")}>
          {/* A tone step, not a bubble: it marks input without drawing a shape. */}
          <div className="rounded-[var(--r)] bg-raised px-2 py-1">
            <p className="text-md whitespace-pre-wrap text-ink">
              {segmentsOf(block.text).map((segment, index) =>
                segment.path ? (
                  <button
                    key={index}
                    type="button"
                    onClick={() => store.openFile(segment.path!)}
                    className="rounded-[var(--r)] border border-rule bg-sunken px-1 font-mono text-sm text-accent-ink hover:border-accent"
                  >
                    {segment.text}
                  </button>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </p>
          </div>
          {block.files?.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {block.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => store.openFile(file.path.replace(/^\/Users\/[^/]+\/crew\//, ""))}
                  className="flex items-center gap-1.5 rounded-[var(--r)] border border-rule px-1.5 py-0.5"
                >
                  <span className="font-mono text-xs text-ink-2">{file.name}</span>
                  {file.size ? (
                    <span className="font-mono text-xs text-ink-4">{bytes(file.size)}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </LogRow>
    );
  }

  return (
    <LogRow
      gutter={shortModel(session.provider, session.model)}
      stamp={block.at ? clock(block.at) : undefined}
      action={<CopyButton text={block.text} />}
      gap={gap}
      id={`block-${block.id}`}
    >
      <div className={clsx(highlighted && "hl-flash rounded-[var(--r)]")}>
        <AssistantBody text={block.text} streaming={Boolean(block.streaming)} />
      </div>
    </LogRow>
  );
}

/**
 * While a reply streams, only the line being typed is plain text; every line
 * that has landed is already markdown, and never animates again.
 */
function AssistantBody({ text, streaming }: { text: string; streaming: boolean }) {
  if (!streaming) return <Markdown text={text} />;
  const { head, tail } = splitStream(text);
  return (
    <>
      {head ? <Markdown text={head} /> : null}
      {tail ? (
        <p className="text-md text-ink-2">
          <StreamText text={tail} />
        </p>
      ) : null}
    </>
  );
}

